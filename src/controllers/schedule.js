// src/controllers/schedule.js

import connectDB from '../db/index.js';
import cron from 'node-cron';
import { instances, initializeSock } from './qrcode.js';
import { logger } from '../logger.js';

// Function to save scheduled message to database
export const saveScheduledMessage = async (instanceId, phoneNumbers, message, media, caption, scheduleTime, delayInMS) => {
    try {
        // Validate that instance exists in database
        if (!instanceId) {
            throw new Error('Instance ID is required');
        }

        const connection = await connectDB();
        
        // Check if instance exists in database
        const [instanceRows] = await connection.execute(
            'SELECT instance_id FROM instances WHERE instance_id = ?',
            [instanceId]
        );

        if (!instanceRows || instanceRows.length === 0) {
            throw new Error(`Instance with ID ${instanceId} does not exist in database`);
        }

        // *************
        // Handle scheduling time
        const currentTime = new Date();
        let scheduledDateTime;
        
        if (!scheduleTime) {
            // Use delayInMS if provided, otherwise default to 4000ms (4 seconds)
            const delay = delayInMS ? parseInt(delayInMS) : 4000;
            scheduledDateTime = new Date(currentTime.getTime() + delay);
        } else {
            scheduledDateTime = new Date(scheduleTime);
            // Only validate future time if schedule_time was explicitly provided
            if (scheduledDateTime <= currentTime) {
                throw new Error('Schedule time must be in the future');
            }
        }
        // *************

        // Format the schedule time while preserving the local timezone
        const pad = (num) => String(num).padStart(2, '0');
        const formattedScheduleTime = `${scheduledDateTime.getFullYear()}-${pad(scheduledDateTime.getMonth() + 1)}-${pad(scheduledDateTime.getDate())} ${pad(scheduledDateTime.getHours())}:${pad(scheduledDateTime.getMinutes())}:${pad(scheduledDateTime.getSeconds())}`;
        
        // Convert phoneNumbers to array if it's not already
        const recipients = Array.isArray(phoneNumbers) ? phoneNumbers : [phoneNumbers];
        
        const query = `
            INSERT INTO media_messages 
            (instance_id, recipient, message, media, caption, schedule_time, message_status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW());
        `;

        const savedIds = [];
        
        // Save separate row for each recipient
        for (const recipient of recipients) {
            const values = [
                instanceId || null,
                recipient.trim(),  // Save single recipient
                message || null,
                media || null,
                caption || null,
                formattedScheduleTime
            ];

            logger.info('Saving scheduled message for recipient:', {
                recipient: recipient.trim(),
                scheduleTime: formattedScheduleTime
            });
            
            const [result] = await connection.execute(query, values);
            savedIds.push(result.insertId);
            logger.info('Scheduled message saved:', { recipient, messageId: result.insertId });
        }

        return savedIds;
    } catch (error) {
        logger.error('Error saving scheduled message:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to send a single message using Baileys with retry
const sendMessage = async (sock, jid, message, retries = 3) => {
    try {
        for (let i = 0; i < retries; i++) {
            try {
                if (!sock || !sock.sendMessage) {
                    logger.error('Invalid socket object');
                    return false;
                }
                
                await sock.sendMessage(jid, { text: message });
                return true;
            } catch (error) {
                if (error.message === 'Timed Out' && i < retries - 1) {
                    // Wait for 1 second before retrying
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                throw error;
            }
        }
        return false;
    } catch (error) {
        logger.error('Error sending message:', error.message);
        return false;
    }
};

// Function to get pending scheduled messages
export const getPendingScheduledMessages = async () => {
    try {
        const connection = await connectDB();
        const query = `
            SELECT id, instance_id, recipient, message, media, caption, schedule_time, message_status 
            FROM media_messages 
            WHERE message_status = 'pending' 
            AND schedule_time <= NOW()
            ORDER BY schedule_time ASC
            LIMIT 50
        `;
        
        const [rows] = await connection.execute(query);
        return rows;
    } catch (error) {
        logger.error('Error getting pending scheduled messages:', error.message);
        throw error;
    }
};

// Initialize scheduler
export const initializeScheduler = () => {
    logger.info('Initializing message scheduler...');
    
    // Run every 2 seconds instead of every 1 second to reduce load
    const scheduler = cron.schedule('*/2 * * * * *', async () => {
        try {
            const pendingMessages = await getPendingScheduledMessages();
            if (pendingMessages.length === 0) return;
            
            // Group messages by instance_id for efficiency
            const messagesByInstance = {};
            pendingMessages.forEach(message => {
                if (!messagesByInstance[message.instance_id]) {
                    messagesByInstance[message.instance_id] = [];
                }
                messagesByInstance[message.instance_id].push(message);
            });
            
            // Process messages by instance
            for (const [instanceId, messages] of Object.entries(messagesByInstance)) {
                if (!instanceId) continue;

                // Get or initialize WhatsApp instance
                let instance = instances[instanceId];
                if (!instance?.sock || instance.status !== 'connected') {
                    try {
                        await initializeSock(instanceId);
                        instance = instances[instanceId];
                        if (!instance?.sock || instance.status !== 'connected') continue;
                    } catch (error) {
                        logger.error(`Error initializing WhatsApp instance ${instanceId}:`, error.message);
                        continue;
                    }
                }
                
                // Process messages sequentially with rate limiting
                for (const message of messages) {
                    try {
                        const formattedNumber = message.recipient.replace(/[+\s-]/g, '');
                        const jid = `${formattedNumber}@s.whatsapp.net`;
                        
                        // Send message with retry mechanism
                        const success = await sendMessage(instance.sock, jid, message.message);
                        await updateScheduledMessageStatus(message.id, success ? 'sent' : 'failed');
                        
                        // Add a small delay between messages to prevent rate limiting
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } catch (err) {
                        logger.error(`Error processing message ${message.id}:`, err.message);
                        await updateScheduledMessageStatus(message.id, 'failed');
                    }
                }
            }
        } catch (error) {
            logger.error('Error in scheduler:', error.message);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    scheduler.start();
    logger.info('Message scheduler initialized');
};

// Function to update message status
export const updateScheduledMessageStatus = async (messageId, message_status) => {
    try {
        const connection = await connectDB();
        const query = `
            UPDATE media_messages 
            SET message_status = ? 
            WHERE id = ?
        `;
        
        await connection.execute(query, [message_status, messageId]);
        logger.info(`Updated message ${messageId} status to: ${message_status}`);
    } catch (error) {
        logger.error('Error updating message status:', error.message);
        throw error;
    }
};

// Function to save media message to database for scheduled sending
export const saveMediaMessage = async (req, res) => {
    try {
        const { instance_id, recipient, schedule_time, message } = req.body;

        if (!instance_id || !recipient || !schedule_time || !message) {
            return res.status(400).json({ error: 'instance_id, recipient, schedule_time and message are required' });
        }

        const connection = await connectDB();

        // Check if instance exists
        const [existingInstances] = await connection.query(
            "SELECT * FROM instances WHERE instance_id = ?",
            [instance_id]
        );

        if (existingInstances.length === 0) {
            return res.status(404).json({ error: 'Instance not found' });
        }

        // Format the phone number - remove any +, spaces, or special characters
        const formattedRecipient = recipient.replace(/[+\s-]/g, '');
        
        // Validate schedule time
        const scheduleDate = new Date(schedule_time);
        if (isNaN(scheduleDate.getTime())) {
            return res.status(400).json({ error: 'Invalid schedule_time format' });
        }

        try {
            // Insert into media_messages with pending status
            const query = `
                INSERT INTO media_messages 
                (instance_id, recipient, message, schedule_time, message_status, created_at) 
                VALUES (?, ?, ?, ?, ?, NOW())
            `;
            
            logger.debug('Inserting message with values:', {
                instance_id,
                formattedRecipient,
                message,
                schedule_time,
                message_status: 'pending'
            });

            const [result] = await connection.execute(query, [
                instance_id, 
                formattedRecipient, 
                message, 
                schedule_time,
                'pending'
            ]);

            return res.status(201).json({ 
                success: true, 
                message: 'Message scheduled successfully',
                id: result.insertId,
                scheduled_time: schedule_time
            });

        } catch (dbError) {
            logger.error('Database error:', { error: dbError.message, stack: dbError.stack });
            return res.status(500).json({ 
                success: false, 
                message: 'Failed to schedule message',
                error: dbError.message 
            });
        }

    } catch (error) {
        logger.error('Error processing request:', { error: error.message, stack: error.stack });
        return res.status(500).json({ error: 'Server error' });
    }
};
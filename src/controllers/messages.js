// src/controllers/messages.js

import connectDB from '../db/index.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

// Function to format the scheduled time
const formatScheduledAt = (scheduledAt) => {
    if (!scheduledAt) return null;

    const date = new Date(scheduledAt);
    if (isNaN(date.getTime())) {
        logger.error('Invalid date provided:', scheduledAt);
        return null;
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}`;
};

// Function to replace placeholders with actual values from recipient data
const replacePlaceholders = async (text, phoneNumber, instanceId) => {
    if (!text || !phoneNumber || !instanceId) return text;
    
    try {
        const connection = await connectDB();
        const cleanPhoneNumber = phoneNumber.replace(/^\+/, '').trim();
        
        // Get recipient data from phoneList table
        const [rows] = await connection.query(
            'SELECT * FROM phoneList WHERE phone_numbers = ? AND instance_id = ?',
            [cleanPhoneNumber, instanceId]
        );
        
        if (rows.length === 0) {
            logger.warn(`No data found for phone number: ${phoneNumber}`);
            return text;
        }
        
        // Replace placeholders with database values
        return text.replace(/\{\{(\w+)\}\}/g, (match, field) => {
            if (rows[0][field] !== undefined) {
                return rows[0][field];
            }
            return match;
        });
        
    } catch (error) {
        logger.error('Error replacing placeholders:', { 
            error: error.message, 
            stack: error.stack,
            phoneNumber,
            instanceId
        });
        return text;
    }
};

// Function to save messaging data to the database
export const logMediaMessageToDB = async (instanceId, phoneNumbers, message, media, caption, scheduleTime, messageStatus, whatsappMessageId) => {
    try {
        const connection = await connectDB();
        
        // Define valid ENUM values for message_status
        const validMessageStatus = ['sent', 'delivered', 'read', 'failed', 'pending'];
        const messageStatusValidated = validMessageStatus.includes(messageStatus) ? messageStatus : 'sent';
        
        // Process each phone number and replace placeholders
        const processedMessages = await Promise.all(
            (Array.isArray(phoneNumbers) ? phoneNumbers : [phoneNumbers]).map(async phoneNumber => {
                const processedMessage = await replacePlaceholders(message, phoneNumber, instanceId);
                const processedCaption = caption ? await replacePlaceholders(caption, phoneNumber, instanceId) : null;
                return { phoneNumber, processedMessage, processedCaption };
            })
        );
        
        // Insert messages into database
        const query = `
            INSERT INTO media_messages 
            (instance_id, recipient, message, media, caption, schedule_time, message_status, whatsapp_message_id, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW());
        `;
        
        const results = await Promise.all(
            processedMessages.map(async ({ phoneNumber, processedMessage, processedCaption }) => {
                const values = [
                    instanceId || null,
                    phoneNumber,
                    processedMessage || null,
                    media || null,
                    processedCaption || null,
                    formatScheduledAt(scheduleTime),
                    messageStatusValidated,
                    whatsappMessageId || null
                ];
                
                logger.info('Logging to DB:', { 
                    instanceId, 
                    phoneNumber, 
                    processedMessage,
                    processedCaption 
                });
                
                const [result] = await connection.execute(query, values);
                return result.insertId;
            })
        );
        
        return results.length === 1 ? results[0] : results;
    } catch (error) {
        logger.error('Failed to log message to DB:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to update message status
export const updateMessageStatusInDB = async (messageId, newStatus) => {
    try {
        const connection = await connectDB();
        const validMessageStatus = ['sent', 'delivered', 'read', 'failed', 'pending'];
        
        if (!validMessageStatus.includes(newStatus)) {
            throw new Error(`Invalid message status: ${newStatus}`);
        }

        // First, get the message details to get the whatsapp_message_id
        const [messageRows] = await connection.query(
            'SELECT whatsapp_message_id, instance_id, recipient, created_at FROM media_messages WHERE id = ?',
            [messageId]
        );
        
        if (messageRows.length === 0) {
            logger.warn(`No message found with ID ${messageId}`);
            return;
        }
        
        const { whatsapp_message_id, instance_id, recipient, created_at } = messageRows[0];

        // Update the message status in media_messages
        const query = `UPDATE media_messages SET message_status = ? WHERE id = ?`;
        const [result] = await connection.execute(query, [newStatus, messageId]);

        if (result.affectedRows > 0) {
            logger.info(`Message status updated successfully for message ID ${messageId} to ${newStatus}`);
            
            // If we have a WhatsApp message ID, update the report_time table as well
            if (whatsapp_message_id) {
                // Determine which timestamp field to update based on the new status
                let statusField = '';
                
                switch (newStatus.toLowerCase()) {
                    case 'sent':
                        statusField = 'sent_time';
                        break;
                    case 'delivered':
                        statusField = 'delivered_time';
                        break;
                    case 'read':
                        statusField = 'read_time';
                        break;
                    case 'failed':
                        statusField = 'failed_time';
                        break;
                    default:
                        statusField = ''; // No specific field for 'pending'
                        break;
                }
                
                if (statusField) {
                    try {
                        // Update the report_time table
                        const reportTimeQuery = `
                            UPDATE report_time 
                            SET ${statusField} = NOW() 
                            WHERE whatsapp_message_id = ?
                        `;
                        
                        const [reportResult] = await connection.execute(reportTimeQuery, [whatsapp_message_id]);
                        
                        if (reportResult.affectedRows > 0) {
                            logger.info(`Updated ${statusField} in report_time for message ID ${whatsapp_message_id}`);
                        } else {
                            logger.warn(`No report_time entry found for message ID ${whatsapp_message_id}`);
                            
                            // If no entry exists, create one
                            await migrateMessageToReportTime(instance_id, recipient, whatsapp_message_id, newStatus, created_at);
                        }
                    } catch (reportError) {
                        logger.error('Failed to update report_time table:', { 
                            error: reportError.message, 
                            stack: reportError.stack,
                            messageId,
                            whatsapp_message_id
                        });
                        // Don't throw here, as we've already updated the media_messages table
                    }
                }
            }
        } else {
            logger.warn(`No rows updated for message ID ${messageId}. It may not exist.`);
        }
    } catch (error) {
        logger.error('Failed to update message status in DB:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Function to send messages
export const sendMessagesOneAtATime = async (messages, mediaPayload, sock, instanceId, filePath, scheduleTime) => {
    let totalMessagesSent = 0;
    const totalNumbers = messages.length;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 3000; // 3 seconds

    // Check if WhatsApp is connected
    if (!sock || !sock.user || !sock.user.id) {
        logger.error('WhatsApp connection not ready');
        throw new Error('WhatsApp connection not ready');
    }

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const getRandomDelay = () => {
        // Random delay between 2 to 3 seconds
        return Math.floor(Math.random() * (3000 - 2000)) + 2000;
    };

    const sendWithRetry = async (jid, messageContent, retryCount = 0) => {
        try {
            const result = await sock.sendMessage(jid, messageContent);
            return { success: true, result };
        } catch (error) {
            if (retryCount < MAX_RETRIES && error.message === 'Timed Out') {
                logger.info(`Retry attempt ${retryCount + 1} for ${jid}`);
                await sleep(RETRY_DELAY);
                return sendWithRetry(jid, messageContent, retryCount + 1);
            }
            throw error;
        }
    };

    for (const message of messages) {
        const jid = `${message.number}@s.whatsapp.net`;

        try {
            let isMediaSent = false;
            let isMessageSent = false;
            let whatsappMessageId = null;

            // Process variable substitution for text and caption
            const processedText = await replacePlaceholders(message.text, message.number, instanceId);
            const processedCaption = await replacePlaceholders(message.caption, message.number, instanceId);
            
            // Log the original and processed messages for debugging
            if (message.text !== processedText || (message.caption && message.caption !== processedCaption)) {
                logger.info('Variable substitution:', {
                    originalText: message.text,
                    processedText,
                    originalCaption: message.caption,
                    processedCaption,
                    phoneNumber: message.number
                });
            }

            // First store the message as pending
            const dbMessageId = await logMediaMessageToDB(
                instanceId,
                [message.number],
                message.text || null, // Store original message with placeholders
                mediaPayload ? filePath : null,
                message.caption || null, // Store original caption with placeholders
                scheduleTime,
                'pending',
                null // whatsapp_message_id will be updated after sending
            );

            // Send media with caption if mediaPayload exists
            if (mediaPayload) {
                logger.info(`Attempting to send media to ${message.number}`, { 
                    fileType: mediaPayload.mimetype || 'document',
                    fileName: mediaPayload.fileName || 'unknown'
                });
                
                try {
                    // Create a copy of mediaPayload with the processed caption
                    const processedMediaPayload = { ...mediaPayload };
                    if (processedCaption) {
                        processedMediaPayload.caption = processedCaption;
                    }
                    
                    const mediaResult = await sendWithRetry(jid, {
                        ...processedMediaPayload,
                        quoted: null
                    });
                    isMediaSent = true;
                    whatsappMessageId = mediaResult.result.key.id;
                    logger.info(`Media sent successfully to ${message.number}`);
                } catch (mediaError) {
                    logger.error(`Failed to send media to ${message.number}:`, { 
                        error: mediaError.message,
                        stack: mediaError.stack 
                    });
                    // Update message status to failed
                    await updateMessageStatusInDB(dbMessageId, 'failed');
                    throw mediaError;
                }
            }

            // Send text message if it exists
            if (processedText) {
                try {
                    const textResult = await sendWithRetry(jid, { 
                        text: processedText,
                        quoted: null
                    });
                    isMessageSent = true;
                    whatsappMessageId = textResult.result.key.id;
                    logger.info(`Text message sent successfully to ${message.number}`);
                } catch (textError) {
                    logger.error(`Failed to send text to ${message.number}:`, { 
                        error: textError.message,
                        stack: textError.stack 
                    });
                    // Update message status to failed
                    await updateMessageStatusInDB(dbMessageId, 'failed');
                    throw textError;
                }
            }

            // Add a random delay between messages to prevent detection
            const randomDelay = getRandomDelay();
            logger.info(`Waiting ${randomDelay/1000} seconds before next message...`);
            await sleep(randomDelay);

            // Update the message with WhatsApp message ID and status
            await updateMessageWithWhatsAppId(dbMessageId, whatsappMessageId);

            totalMessagesSent++;
            logger.info(`Progress: ${totalMessagesSent}/${totalNumbers} messages sent`);

        } catch (err) {
            logger.error(`Error sending message to ${message.number}:`, { 
                error: err.message,
                stack: err.stack 
            });
        }
    }

    return totalMessagesSent;
};

// Send text message and return the message ID
export const sendTextMessage = async (sock, recipient, message) => {
    try {
        const msg = await sock.sendMessage(recipient + "@s.whatsapp.net", {
            text: message
        });
        return msg.key.id; // Return the WhatsApp message ID
    } catch (error) {
        logger.error('Failed to send text message:', error);
        throw error;
    }
};

// Function to migrate a message to the report_time table
export const migrateMessageToReportTime = async (instanceId, recipient, whatsappMessageId, messageStatus, createdAt) => {
    try {
        if (!instanceId || !recipient || !whatsappMessageId) {
            logger.warn('Missing required parameters for migrateMessageToReportTime');
            return;
        }

        const connection = await connectDB();
        
        // First, check if the report_time table exists, if not create it
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS report_time (
                id INT AUTO_INCREMENT PRIMARY KEY,
                instance_id VARCHAR(255) NOT NULL,
                recipient VARCHAR(255) NOT NULL,
                whatsapp_message_id VARCHAR(255) NOT NULL,
                initiated_time TIMESTAMP NULL,
                sent_time TIMESTAMP NULL,
                delivered_time TIMESTAMP NULL,
                read_time TIMESTAMP NULL,
                failed_time TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_whatsapp_message_id (whatsapp_message_id),
                INDEX idx_instance_id (instance_id),
                INDEX idx_recipient (recipient)
            )
        `;
        
        await connection.query(createTableQuery);
        
        // Determine which timestamp to set based on message_status
        let statusField = '';
        
        switch (messageStatus.toLowerCase()) {
            case 'sent':
                statusField = 'sent_time';
                break;
            case 'delivered':
                statusField = 'delivered_time';
                break;
            case 'read':
                statusField = 'read_time';
                break;
            case 'failed':
                statusField = 'failed_time';
                break;
            default:
                statusField = 'initiated_time';
                break;
        }
        
        // Handle multiple recipients
        const recipients = Array.isArray(recipient) ? recipient : recipient.split(',');
        
        for (const singleRecipient of recipients) {
            if (!singleRecipient.trim()) continue;
            
            // Insert into report_time
            const insertQuery = `
                INSERT INTO report_time 
                (instance_id, recipient, whatsapp_message_id, initiated_time, ${statusField}, created_at) 
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    initiated_time = VALUES(initiated_time),
                    ${statusField} = VALUES(${statusField})
            `;
            
            await connection.query(insertQuery, [
                instanceId,
                singleRecipient.trim(),
                whatsappMessageId,
                createdAt || new Date(), // Set initiated_time to created_at or current time
                createdAt || new Date(),
                createdAt || new Date()
            ]);
        }
        
        logger.info('Message migrated to report_time table', {
            instanceId,
            recipient,
            whatsappMessageId,
            messageStatus
        });
    } catch (error) {
        logger.error('Failed to migrate message to report_time:', { 
            error: error.message, 
            stack: error.stack,
            instanceId,
            recipient,
            whatsappMessageId
        });
    }
};

// Function to update message with WhatsApp ID
export const updateMessageWithWhatsAppId = async (dbId, whatsappMessageId) => {
    try {
        if (!dbId || !whatsappMessageId) {
            logger.error('Missing required parameters for updateMessageWithWhatsAppId');
            return;
        }

        const connection = await connectDB();
        
        // First, get the message details
        const [messageRows] = await connection.query(
            'SELECT instance_id, recipient, created_at FROM media_messages WHERE id = ?',
            [dbId]
        );
        
        if (messageRows.length === 0) {
            logger.error(`No message found with ID ${dbId}`);
            return;
        }
        
        const { instance_id, recipient, created_at } = messageRows[0];
        
        // Update the message status and WhatsApp message ID
        const query = `
            UPDATE media_messages 
            SET whatsapp_message_id = ?, message_status = ? 
            WHERE id = ?
        `;
        
        const [result] = await connection.execute(query, [whatsappMessageId, 'sent', dbId]);
        
        if (result.affectedRows > 0) {
            logger.info(`Message ${dbId} updated with WhatsApp ID ${whatsappMessageId}`);
            
            // Migrate the message to report_time table
            await migrateMessageToReportTime(instance_id, recipient, whatsappMessageId, 'sent', created_at);
        } else {
            logger.warn(`No message updated with ID ${dbId}`);
        }
        
        return result.affectedRows > 0;
    } catch (error) {
        logger.error('Failed to update message with WhatsApp ID:', { 
            error: error.message, 
            stack: error.stack,
            dbId,
            whatsappMessageId
        });
        return false;
    }
};

// Send messages function
export const sendMessages = async (req, res) => {
    try {
        const { instanceId, messages } = req.body;
        const sock = getSocketConnection(instanceId);
        
        if (!sock) {
            return res.status(400).json({ error: 'Instance not found' });
        }

        let progress = 0;
        const total = messages.length;

        for (const messageData of messages) {
            let dbId;
            try {
                // First log to DB with pending status
                dbId = await logMediaMessageToDB(
                    instanceId,
                    [messageData.recipient],
                    messageData.message,
                    null, // media
                    null, // caption
                    messageData.schedule_time,
                    'pending',
                    null // whatsapp_message_id will be updated after sending
                );

                // Send message and get WhatsApp message ID
                const whatsappMessageId = await sendTextMessage(sock, messageData.recipient, messageData.message);
                
                // Update DB record with WhatsApp message ID and status
                await updateMessageWithWhatsAppId(dbId, whatsappMessageId);

                progress++;
                logger.info(`Progress: ${progress}/${total} messages sent`);

                // Add delay between messages
                if (progress < total) {
                    const delay = Math.random() * 4000 + 2000; // 2-6 seconds
                    logger.info(`Waiting ${(delay/1000).toFixed(3)} seconds before next message...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                logger.error('Failed to send message:', error);
                // Update status to failed if we have a dbId
                if (dbId) {
                    await updateMessageStatusInDB(dbId, 'failed');
                }
            }
        }

        res.json({ success: true, message: `${progress}/${total} messages sent successfully` });
    } catch (error) {
        logger.error('Error in sendMessages:', error);
        res.status(500).json({ error: error.message });
    }
};

// Handle media message sending
export const sendMedia = async (req, res) => {
    const { instanceId, sock } = req;
    const { messages, filePath, scheduleTime } = req.body;

    try {
        // Validate required fields
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Messages are required and must be an array' 
            });
        }

        // Get latest subscription details
        const connection = await connectDB();
        const [subscriptionDetails] = await connection.query(
            'SELECT s.* FROM subscription s ' +
            'WHERE s.instance_id = ? ' +
            'AND s.date_expiry >= CURDATE() ' +  // Only get active subscription
            'ORDER BY s.created_at DESC, s.id DESC ' +  // Order by created_at and id to get the newest
            'LIMIT 1',
            [instanceId]
        );

        if (!subscriptionDetails || subscriptionDetails.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No active subscription found'
            });
        }

        const subscription = subscriptionDetails[0];
        logger.info('Current Subscription:', { subscription });

        // Get count of messages sent in current subscription period
        const [messageCount] = await connection.query(
            'SELECT COUNT(*) as count FROM media_messages ' +
            'WHERE instance_id = ? ' +
            'AND created_at >= ? ' +
            'AND created_at <= COALESCE(?, NOW()) ' +  // Only count messages within subscription period
            'AND created_at >= (SELECT created_at FROM subscription ' +  // Only count messages after this subscription was created
            '                  WHERE instance_id = ? ' +
            '                  AND id = ?)',
            [instanceId, subscription.date_purchased, subscription.date_expiry, instanceId, subscription.id]
        );

        const totalMessagesSent = messageCount[0].count;
        const messagesRemaining = subscription.num_messages - totalMessagesSent;

        logger.info('Message Stats:', {
            totalMessages: subscription.num_messages,
            totalSent: totalMessagesSent,
            remaining: messagesRemaining,
            subscriptionId: subscription.id,
            datePurchased: subscription.date_purchased,
            dateExpiry: subscription.date_expiry,
            createdAt: subscription.created_at
        });

        if (messagesRemaining <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Message limit reached. Please recharge your subscription.'
            });
        }

        // Check if total numbers to send exceeds remaining messages
        if (messages.length > messagesRemaining) {
            return res.status(400).json({
                success: false,
                message: `Can only send ${messagesRemaining} more messages with current subscription`
            });
        }

        if (!sock) {
            return res.status(400).json({ 
                success: false,
                message: 'WhatsApp instance not connected' 
            });
        }

        let mediaPayload = null;
        let fileExtension = null;

        // Process media file if provided
        if (filePath) {
            try {
                // Check if file exists
                if (!fs.existsSync(filePath)) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'File not found' 
                    });
                }

                // Check file size (16MB limit)
                const stats = fs.statSync(filePath);
                const fileSizeInMB = stats.size / (1024 * 1024);
                if (fileSizeInMB > 16) {
                    return res.status(400).json({ 
                        success: false,
                        message: 'File size exceeds 16MB limit' 
                    });
                }

                fileExtension = path.extname(filePath).toLowerCase();
                const fileBuffer = await fs.promises.readFile(filePath);
                const mimeTypes = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.mp4': 'video/mp4',
                    '.mov': 'video/quicktime',
                    '.mp3': 'audio/mpeg',
                    '.wav': 'audio/wav',
                    '.ogg': 'audio/ogg',
                    '.pdf': 'application/pdf',
                    '.doc': 'application/msword',
                    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                };

                switch (fileExtension) {
                    case '.jpg':
                    case '.jpeg':
                    case '.png':
                        mediaPayload = {
                            image: fileBuffer,
                            caption: messages[0].caption || '',
                            mimetype: mimeTypes[fileExtension]
                        };
                        break;
                    case '.mp4':
                    case '.mov':
                        mediaPayload = {
                            video: fileBuffer,
                            caption: messages[0].caption || '',
                            mimetype: mimeTypes[fileExtension]
                        };
                        break;
                    case '.mp3':
                    case '.wav':
                    case '.ogg':
                        mediaPayload = {
                            audio: fileBuffer,
                            mimetype: mimeTypes[fileExtension],
                            ptt: fileExtension === '.ogg',
                            caption: messages[0].caption || ''
                        };
                        break;
                    case '.pdf':
                    case '.doc':
                    case '.docx':
                        mediaPayload = {
                            document: fileBuffer,
                            mimetype: mimeTypes[fileExtension],
                            fileName: path.basename(filePath),
                            caption: messages[0].caption || ''
                        };
                        break;
                    default:
                        // For Excel and other files, send as document with auto-detected mimetype
                        mediaPayload = {
                            document: fileBuffer,
                            fileName: path.basename(filePath),
                            caption: messages[0].caption || '',
                            mimetype: 'application/octet-stream'  // Generic binary file type
                        };
                }

                // Log the media payload for debugging
                logger.info('Media payload created:', {
                    type: fileExtension,
                    fileName: path.basename(filePath),
                    size: fileBuffer.length,
                    mimeType: mediaPayload.mimetype || 'application/octet-stream'
                });
            } catch (error) {
                logger.error('Media processing error:', { error: error.message });
                return res.status(400).json({ 
                    success: false,
                    message: error.message || 'Invalid or missing media file' 
                });
            }
        }

        // Send messages with logging
        const totalSent = await sendMessagesOneAtATime(
            messages,
            mediaPayload,
            sock,
            instanceId,
            filePath,
            scheduleTime
        );

        // Return success response
        res.json({
            success: true,
            message: `Successfully processed ${totalSent} messages`,
            totalMessages: totalSent
        });

    } catch (error) {
        logger.error('Error in sendMedia:', { error: error.message, stack: error.stack });
        
        // Log the error message to database
        try {
            if (messages && instanceId) {
                await logMediaMessageToDB(
                    instanceId,
                    messages.map(message => message.number),
                    messages[0].text,
                    filePath,
                    messages[0].caption,
                    scheduleTime,
                    'failed',
                    null
                );
            }
        } catch (dbError) {
            logger.error('Error logging to database:', { error: dbError.message, stack: dbError.stack });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to send messages',
            error: error.message
        });
    }
};
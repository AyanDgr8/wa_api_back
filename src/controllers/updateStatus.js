// src/controllers/updateStatus.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

// Valid ENUM values for `message_status`
const MESSAGE_STATUS = {
    PENDING: 'pending',
    SENT: 'sent',
    DELIVERED: 'delivered',
    READ: 'read',
    FAILED: 'failed'
};

// Function to get database ID from WhatsApp message ID
const getDatabaseId = async (instanceId, messageId) => {
    try {
        const connection = await connectDB();
        
        // First try to find the message by exact whatsapp_message_id
        const query = `SELECT id FROM media_messages WHERE instance_id = ? AND whatsapp_message_id = ?`;
        const [rows] = await connection.query(query, [instanceId, messageId]);
        
        const found = rows.length > 0;
        const dbId = found ? rows[0].id : null;
        
        logger.info('Database lookup result:', {
            instanceId,
            messageId,
            dbId,
            found,
            timestamp: new Date().toISOString()
        });
        
        // If not found, try a more flexible search (some IDs might have prefixes or suffixes)
        if (!found) {
            logger.info(`Message ID ${messageId} not found with exact match, trying flexible search`);
            
            const flexibleQuery = `SELECT id FROM media_messages WHERE instance_id = ? AND whatsapp_message_id LIKE ?`;
            const [flexibleRows] = await connection.query(flexibleQuery, [instanceId, `%${messageId}%`]);
            
            const flexibleFound = flexibleRows.length > 0;
            const flexibleDbId = flexibleFound ? flexibleRows[0].id : null;
            
            logger.info('Flexible database lookup result:', {
                instanceId,
                messageId,
                dbId: flexibleDbId,
                found: flexibleFound,
                timestamp: new Date().toISOString()
            });
            
            if (flexibleFound) {
                return { found: true, dbId: flexibleDbId };
            }
            
            // As a last resort, check the most recent pending messages
            logger.info(`Message ID ${messageId} not found with flexible search, checking recent pending messages`);
            
            const pendingQuery = `
                SELECT id FROM media_messages 
                WHERE instance_id = ? AND message_status = 'pending' 
                ORDER BY created_at DESC LIMIT 5
            `;
            const [pendingRows] = await connection.query(pendingQuery, [instanceId]);
            
            if (pendingRows.length > 0) {
                const pendingId = pendingRows[0].id;
                
                logger.info(`Using most recent pending message as fallback:`, {
                    instanceId,
                    messageId,
                    pendingId,
                    timestamp: new Date().toISOString()
                });
                
                // Update this pending message with the WhatsApp message ID
                const updateQuery = `UPDATE media_messages SET whatsapp_message_id = ? WHERE id = ?`;
                await connection.query(updateQuery, [messageId, pendingId]);
                
                return { found: true, dbId: pendingId };
            }
        }
        
        return { found, dbId };
    } catch (error) {
        logger.error('Failed to get database ID:', {
            error: error.message,
            stack: error.stack,
            instanceId,
            messageId
        });
        return { found: false, dbId: null };
    }
};

// Function to update message status in the database
export const updateMessageStatusInDB = async (messageId, newStatus) => {
    // Validate status
    if (!Object.values(MESSAGE_STATUS).includes(newStatus)) {
        logger.warn(`Invalid message status: ${newStatus}, defaulting to 'sent'`);
        newStatus = MESSAGE_STATUS.SENT;
    }

    try {
        const connection = await connectDB();
        
        // Update status in media_messages table
        const query = `UPDATE media_messages SET message_status = ? WHERE id = ?`;
        const [result] = await connection.query(query, [newStatus, messageId]);
        
        if (result.affectedRows === 0) {
            logger.warn(`No message found with ID ${messageId}`);
            return {
                success: false,
                error: 'Message not found',
                messageId,
                newStatus
            };
        }
        
        // Get the whatsapp_message_id and instance_id for this message
        const getMessageQuery = `
            SELECT whatsapp_message_id, instance_id, recipient 
            FROM media_messages 
            WHERE id = ?
        `;
        const [messageRows] = await connection.query(getMessageQuery, [messageId]);
        
        if (messageRows.length === 0) {
            logger.warn(`No message found with ID ${messageId} for status update`);
            return { 
                success: false, 
                error: 'Message not found',
                messageId,
                newStatus
            };
        }
        
        const { whatsapp_message_id, instance_id, recipient } = messageRows[0];
        
        if (!whatsapp_message_id) {
            logger.warn(`Message with ID ${messageId} has no WhatsApp message ID`);
            return {
                success: false,
                error: 'No WhatsApp message ID',
                messageId,
                newStatus
            };
        }
        
        logger.info(`Updating status for message: ${messageId}, WhatsApp ID: ${whatsapp_message_id}, Status: ${newStatus}`);
        
        // Determine which timestamp to update based on the new status
        let timeField = '';
        switch (newStatus) {
            case MESSAGE_STATUS.SENT:
                timeField = 'sent_time';
                break;
            case MESSAGE_STATUS.DELIVERED:
                timeField = 'delivered_time';
                break;
            case MESSAGE_STATUS.READ:
                timeField = 'read_time';
                break;
            case MESSAGE_STATUS.FAILED:
                timeField = 'failed_time';
                break;
            case MESSAGE_STATUS.PENDING:
                timeField = 'initiated_time';
                break;
            default:
                break;
        }
        
        if (timeField) {
            // Check if an entry already exists in report_time
            const checkQuery = `
                SELECT id FROM report_time 
                WHERE whatsapp_message_id = ?
            `;
            const [existingRows] = await connection.query(checkQuery, [whatsapp_message_id]);
            
            if (existingRows.length === 0) {
                // No existing entry, create a new one with the appropriate timestamp
                const recipients = recipient ? recipient.split(',') : [];
                
                if (recipients.length > 0) {
                    for (const singleRecipient of recipients) {
                        // Check if an entry already exists for this recipient
                        const checkRecipientQuery = `
                            SELECT id FROM report_time 
                            WHERE instance_id = ? AND recipient = ?
                        `;
                        const [existingRecipientRows] = await connection.query(checkRecipientQuery, [instance_id, singleRecipient]);
                        
                        if (existingRecipientRows.length === 0) {
                            // No existing entry for this recipient, create a new one
                            const insertQuery = `
                                INSERT INTO report_time 
                                (instance_id, recipient, whatsapp_message_id, ${timeField}, created_at) 
                                VALUES (?, ?, ?, NOW(), NOW())
                            `;
                            
                            const [insertResult] = await connection.query(insertQuery, [
                                instance_id,
                                singleRecipient,
                                whatsapp_message_id
                            ]);
                            
                            logger.info(`Created new report_time entry for recipient ${singleRecipient} with status ${newStatus}`, {
                                messageId,
                                whatsappMessageId: whatsapp_message_id,
                                timestamp: new Date().toISOString()
                            });
                        } else {
                            // Entry exists for this recipient, update it
                            const updateRecipientQuery = `
                                UPDATE report_time 
                                SET ${timeField} = NOW(), whatsapp_message_id = ?
                                WHERE id = ?
                            `;
                            
                            const [updateResult] = await connection.query(updateRecipientQuery, [
                                whatsapp_message_id,
                                existingRecipientRows[0].id
                            ]);
                            
                            logger.info(`Updated existing report_time entry for recipient ${singleRecipient} with status ${newStatus}`, {
                                messageId,
                                whatsappMessageId: whatsapp_message_id,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                }
            } else {
                // Entry exists, update it with the appropriate timestamp
                const updateReportQuery = `
                    UPDATE report_time 
                    SET ${timeField} = NOW()
                    WHERE whatsapp_message_id = ?
                `;
                
                const [updateResult] = await connection.query(updateReportQuery, [whatsapp_message_id]);
                
                logger.info(`Updated existing report_time entry with status ${newStatus}`, {
                    messageId,
                    whatsappMessageId: whatsapp_message_id,
                    affectedRows: updateResult.affectedRows,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        return {
            success: true,
            affectedRows: result.affectedRows,
            messageId,
            newStatus
        };
    } catch (error) {
        logger.error('Failed to update message status in DB:', {
            error: error.message,
            stack: error.stack,
            messageId,
            newStatus
        });
        return { success: false, error: error.message };
    }
};

// Function to setup message status tracking for a WhatsApp instance
export const setupMessageStatusTracking = (sock, instanceId) => {
    if (!sock || !instanceId) {
        logger.error('Invalid socket or instanceId provided for status tracking');
        return;
    }

    logger.info(`Setting up message status tracking for instance: ${instanceId}`);

    // Track message status updates
    sock.ev.on('messages.update', async updates => {
        logger.info(`Received messages.update for instance ${instanceId}:`, { 
            updates: JSON.stringify(updates),
            timestamp: new Date().toISOString()
        });
        
        for (const update of updates) {
            if (!update.key || !update.update) {
                logger.warn('Invalid update object received:', { update });
                continue;
            }

            const messageId = update.key.id;
            const remoteJid = update.key.remoteJid;
            
            // Log the raw update
            logger.info('Processing message update:', {
                messageId,
                remoteJid,
                update: JSON.stringify(update.update),
                timestamp: new Date().toISOString()
            });

            // Check message status
            if (update.update.status !== undefined) {
                logger.info('Processing status code:', {
                    status: update.update.status,
                    messageId,
                    timestamp: new Date().toISOString()
                });

                // Get database ID for this WhatsApp message
                const { found, dbId } = await getDatabaseId(instanceId, messageId);
                
                if (!found) {
                    logger.warn('Message not found in database:', {
                        instanceId,
                        messageId,
                        timestamp: new Date().toISOString()
                    });
                    continue;
                }

                let newStatus;
                switch (update.update.status) {
                    case 'PENDING':
                    case 1:
                        newStatus = MESSAGE_STATUS.PENDING;
                        break;
                    case 2: // Sent
                        newStatus = MESSAGE_STATUS.SENT;
                        break;
                    case 3: // Delivered
                        newStatus = MESSAGE_STATUS.DELIVERED;
                        break;
                    case 4: // Read
                        newStatus = MESSAGE_STATUS.READ;
                        break;
                    case -1: // Failed
                        newStatus = MESSAGE_STATUS.FAILED;
                        break;
                    default:
                        newStatus = MESSAGE_STATUS.SENT;
                }

                // Update status in database
                const updateResult = await updateMessageStatusInDB(dbId, newStatus);
                
                logger.info('Message status update result:', {
                    messageId: dbId,
                    whatsappMessageId: messageId,
                    newStatus,
                    success: updateResult.success,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });

    // Track delivery and read receipts
    sock.ev.on('message-receipt.update', async updates => {
        logger.info(`Received message-receipt.update for instance ${instanceId}:`, { 
            updates: JSON.stringify(updates),
            timestamp: new Date().toISOString()
        });
        
        for (const update of updates) {
            if (!update.key) {
                logger.warn('Invalid receipt update object received:', { update });
                continue;
            }
            
            const messageId = update.key.id;
            const { found, dbId } = await getDatabaseId(instanceId, messageId);
            
            if (!found) {
                logger.warn('Message not found for receipt update:', {
                    instanceId,
                    messageId,
                    timestamp: new Date().toISOString()
                });
                continue;
            }

            if (update.receipt) {
                const receiptType = update.receipt.type;
                logger.info(`Processing receipt update of type ${receiptType} for message ${messageId}`);
                
                const newStatus = receiptType === 'read' ? 
                    MESSAGE_STATUS.READ : MESSAGE_STATUS.DELIVERED;
                
                const updateResult = await updateMessageStatusInDB(dbId, newStatus);
                
                logger.info('Receipt update result:', {
                    messageId: dbId,
                    whatsappMessageId: messageId,
                    receiptType,
                    newStatus,
                    success: updateResult.success,
                    timestamp: new Date().toISOString()
                });
            }
        }
    });

    logger.info(`Message status tracking setup complete for instance: ${instanceId}`);
};

// Export MESSAGE_STATUS for use in other files
export { MESSAGE_STATUS };
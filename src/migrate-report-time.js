// src/migrate-report-time.js

import connectDB from './db/index.js';
// import { logger } from './logger.js';

const migrateReportTime = async () => {
    try {
        console.log('Starting migration of report_time table...');
        
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
        console.log('Ensured report_time table exists');
        
        // Get all messages with whatsapp_message_id
        const [messages] = await connection.query(`
            SELECT id, instance_id, recipient, whatsapp_message_id, message_status, created_at 
            FROM media_messages 
            WHERE whatsapp_message_id IS NOT NULL AND whatsapp_message_id != ''
        `);
        
        console.log(`Found ${messages.length} messages to migrate`);
        
        for (const message of messages) {
            // Determine which timestamp to set based on message_status
            let statusField = '';
            
            switch (message.message_status.toLowerCase()) {
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
            
            // Always set initiated_time for all messages
            // Handle multiple recipients
            const recipients = message.recipient.split(',');
            
            for (const recipient of recipients) {
                if (!recipient.trim()) continue;
                
                // Insert into report_time with both initiated_time and the status-specific time
                const insertQuery = `
                    INSERT INTO report_time 
                    (instance_id, recipient, whatsapp_message_id, initiated_time, ${statusField}, created_at) 
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE 
                        initiated_time = VALUES(initiated_time),
                        ${statusField} = VALUES(${statusField})
                `;
                
                await connection.query(insertQuery, [
                    message.instance_id,
                    recipient.trim(),
                    message.whatsapp_message_id,
                    message.created_at, // Set initiated_time to created_at for all messages
                    message.created_at,
                    message.created_at
                ]);
            }
        }
        
        console.log('Migration completed successfully');

        // Now update any records that have NULL initiated_time
        console.log('Updating records with NULL initiated_time...');
        
        const [recordsToUpdate] = await connection.query(`
            SELECT r.id, r.whatsapp_message_id, m.created_at
            FROM report_time r
            JOIN media_messages m ON r.whatsapp_message_id = m.whatsapp_message_id
            WHERE r.initiated_time IS NULL
        `);
        
        console.log(`Found ${recordsToUpdate.length} records with NULL initiated_time`);
        
        for (const record of recordsToUpdate) {
            await connection.query(
                'UPDATE report_time SET initiated_time = ? WHERE id = ?',
                [record.created_at, record.id]
            );
        }
        
        console.log('Initiated time update completed successfully');
    } catch (error) {
        console.error('Migration failed:', error);
    }
};

migrateReportTime();
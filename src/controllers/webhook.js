// src/controllers/webhook.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Process payment webhook and save registration data
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleWebhook = async (req, res) => {
    const connection = await connectDB();
    
    try {
        const { data } = req.body;
        
        // Extract relevant information from payload
        const {
            contact,
            plan_title,
            plan_price,
            plan_start_date,
            plan_order_id,
            site_name
        } = data;

        // Extract user information
        const {
            name: { first: firstName, last: lastName },
            email,
            phone: rawPhone,  // Rename to rawPhone to indicate it's not normalized yet
            company,
            address: { addressLine }
        } = contact;

        // Normalize phone number
        const phone = rawPhone.replace(/[\s\-()]/g, '');  // Remove spaces and special chars
        if (!phone.startsWith('+')) {
            phone = phone.startsWith('91') ? `+${phone}` : `+91${phone}`;
        }

        // Log the incoming webhook data
        logger.info('Received payment webhook:', { 
            orderId: plan_order_id,
            email,
            phone,  // Log normalized phone
            amount: plan_price.value,
            package: plan_title,
            siteName: site_name
        });

        try {
            // Convert date from "DD/MM/YY" to "YYYY-MM-DD"
            const formatDate = (dateStr) => {
                const [day, month, year] = dateStr.split('/');
                return `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
            };

            const startDate = formatDate(plan_start_date);

            // Insert into website_registration table only
            await connection.query(
                `INSERT INTO website_registration (
                    f_name,
                    l_name,
                    phone,
                    email,
                    package_purchased,
                    date_of_purchase,
                    amount_paid,
                    address,
                    company_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    firstName,                    // first_name
                    lastName,                     // last_name
                    phone,                        // phone
                    email,                        // email
                    plan_title,                   // package_purchased
                    startDate,                    // date_of_purchase
                    parseFloat(plan_price.value), // amount_paid
                    addressLine || '',            // address
                    company || null               // company_name
                ]
            );

            // Log successful registration
            logger.info('Website registration saved:', {
                email,
                orderId: plan_order_id,
                package: plan_title
            });

            // Return success response
            return res.status(200).json({
                success: true,
                message: 'Registration data saved successfully'
            });

        } catch (error) {
            logger.error('Database error:', {
                error: error.message,
                stack: error.stack,
                sql: error.sql,
                sqlMessage: error.sqlMessage
            });
            return res.status(500).json({
                success: false,
                message: `Failed to save registration data: ${error.message}`
            });
        }

    } catch (error) {
        logger.error('Webhook processing error:', {
            error: error.message,
            stack: error.stack
        });
        return res.status(500).json({
            success: false,
            message: `Failed to process webhook: ${error.message}`
        });
    }
};
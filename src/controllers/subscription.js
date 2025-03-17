// src/controllers/subscription.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

export const checkSubscription = async (req, res) => {
    try {
        const { id: instance_id } = req.params;
        const connection = await connectDB();
        
        // Check if subscription exists
        const [subscription] = await connection.query(
            'SELECT id FROM subscription WHERE instance_id = ? LIMIT 1',
            [instance_id]
        );

        res.json({
            success: true,
            hasSubscription: subscription && subscription.length > 0
        });

    } catch (error) {
        logger.error('Error in checkSubscription:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

export const getSubscriptionDetails = async (req, res) => {
    try {
        const { id: instance_id } = req.params;
        
        // Get database connection
        const connection = await connectDB();
        
        // Get current subscription details - get the latest subscription entry
        const [currentSubscription] = await connection.query(
            'WITH latest_sub AS ( ' +
            '    SELECT * FROM subscription ' +
            '    WHERE instance_id = ? ' +
            '    AND date_expiry >= CURDATE() ' +
            '    ORDER BY created_at DESC, id DESC ' +
            '    LIMIT 1 ' +
            '), ' +
            'prev_sub AS ( ' +
            '    SELECT created_at as prev_start, date_expiry as prev_end ' +
            '    FROM subscription ' +
            '    WHERE instance_id = ? ' +
            '    AND created_at < (SELECT created_at FROM latest_sub) ' +
            '    ORDER BY created_at DESC ' +
            '    LIMIT 1 ' +
            ') ' +
            'SELECT ' +
            'ls.*, ' +
            '(SELECT COUNT(*) FROM media_messages ' +
            'WHERE instance_id = ls.instance_id ' +
            'AND created_at >= ls.created_at) as messages_sent, ' +
            '(SELECT COUNT(*) FROM media_messages ' +
            'WHERE instance_id = ls.instance_id ' +
            'AND created_at >= ls.created_at ' +
            'AND message_status != "failed") as successful_messages, ' +
            '(SELECT COUNT(*) FROM media_messages ' +
            'WHERE instance_id = ls.instance_id ' +
            'AND created_at >= ls.created_at ' +
            'AND message_status = "failed") as failed_messages, ' +
            'DATEDIFF(ls.date_expiry, CURDATE()) as days_remaining ' +
            'FROM latest_sub ls ' +
            'LEFT JOIN prev_sub ps ON 1=1',
            [instance_id, instance_id]
        );

        // Get all-time stats with sum of all purchased messages
        const [allTimeStats] = await connection.query(
            'SELECT ' +
            '(SELECT SUM(num_messages) FROM subscription WHERE instance_id = ?) as total_messages_purchased, ' +
            '(SELECT COUNT(*) FROM media_messages WHERE instance_id = ?) as total_messages_sent, ' +
            '(SELECT COUNT(*) FROM media_messages WHERE instance_id = ? AND message_status = "failed") as total_failed_messages, ' +
            '(SELECT COUNT(*) FROM media_messages WHERE instance_id = ? AND message_status != "failed") as total_successful_messages ' +
            'FROM dual',
            [instance_id, instance_id, instance_id, instance_id]
        );

        // Get package statistics
        const [packageStats] = await connection.query(
            'SELECT package, COUNT(*) as count FROM subscription ' +
            'WHERE instance_id = ? ' +
            'GROUP BY package',
            [instance_id]
        );

        // Create a map of package counts
        const packageCounts = {
            "Trial": 0,
            "Neo": 0,
            "Starter": 0,
            "Pro": 0,
            "Pro Max": 0,
            "Pulse": 0
        };

        // Fill in the actual counts from the database
        packageStats.forEach(stat => {
            if (packageCounts.hasOwnProperty(stat.package)) {
                packageCounts[stat.package] = parseInt(stat.count);
            }
        });

        if (!currentSubscription || currentSubscription.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No subscription found for this instance' 
            });
        }

        const subscriptionData = currentSubscription[0];
        const allTimeData = allTimeStats[0];

        // Current subscription stats
        const messages_sent = parseInt(subscriptionData.messages_sent) || 0;
        const failed_messages = parseInt(subscriptionData.failed_messages) || 0;
        const successful_messages = parseInt(subscriptionData.successful_messages) || 0;
        const messages_remaining = Math.max(0, subscriptionData.num_messages - messages_sent);
        const days_remaining = parseInt(subscriptionData.days_remaining) || 0;

        // All-time stats
        const total_messages_sent = parseInt(allTimeData.total_messages_sent) || 0;
        const total_failed_messages = parseInt(allTimeData.total_failed_messages) || 0;
        const total_successful_messages = parseInt(allTimeData.total_successful_messages) || 0;
        const total_messages_purchased = parseInt(allTimeData.total_messages_purchased) || 0;

        // Check if the subscription is expired
        const isExpired = new Date(subscriptionData.date_expiry) < new Date();

        res.json({
            success: true,
            data: {
                current: {
                    ...subscriptionData,
                    messages_sent,
                    failed_messages,
                    successful_messages,
                    messages_remaining,
                    total_messages: subscriptionData.num_messages,
                    is_expired: isExpired,
                    days_remaining
                },
                allTime: {
                    messages_sent: total_messages_sent,
                    failed_messages: total_failed_messages,
                    successful_messages: total_successful_messages,
                    total_messages: total_messages_purchased
                },
                packageStats: packageCounts
            }
        });

    } catch (error) {
        logger.error('Error in getSubscriptionDetails:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error' 
        });
    }
};

// Add new subscription
export const addSubscription = async (req, res) => {
    try {
        const { id: instance_id } = req.params;
        const { package: packageName } = req.body;
        
        const connection = await connectDB();

        // Get package details (you should have a packages table with this information)
        const [packageDetails] = await connection.query(
            'SELECT num_messages, validity_days FROM packages WHERE name = ?',
            [packageName]
        );

        if (!packageDetails || packageDetails.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid package selected'
            });
        }

        const { num_messages, validity_days } = packageDetails[0];

        // Calculate expiry date
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + validity_days);

        // Insert new subscription
        await connection.query(
            'INSERT INTO subscription (instance_id, package, num_messages, date_purchased, date_expiry) ' +
            'VALUES (?, ?, ?, CURDATE(), ?)',
            [instance_id, packageName, num_messages, expiryDate]
        );

        res.json({
            success: true,
            message: 'Subscription added successfully'
        });

    } catch (error) {
        logger.error('Error in addSubscription:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
};
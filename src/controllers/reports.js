// src/controllers/reports.js

import connectDB from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Get message reports with optional filtering
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getMessageReports = async (req, res) => {
    try {
        const { instance_id } = req.params;
        const { start_date, end_date, recipient, status, limit = 100, offset = 0 } = req.query;
        
        const connection = await connectDB();
        
        // Use media_messages as primary source and get timing info from report_time
        let reportQuery = `
            SELECT 
                m.id,
                m.instance_id,
                m.recipient,
                m.message,
                m.media,
                m.caption,
                m.message_status,
                m.created_at,
                m.whatsapp_message_id,
                MAX(r.initiated_time) as initiated_time,
                MAX(r.sent_time) as sent_time,
                MAX(r.delivered_time) as delivered_time,
                MAX(r.read_time) as read_time
            FROM media_messages m
            LEFT JOIN report_time r ON 
                m.instance_id = r.instance_id AND 
                m.whatsapp_message_id = r.whatsapp_message_id
            WHERE m.instance_id = ?
            ${recipient ? 'AND m.recipient LIKE ?' : ''}
            ${start_date ? 'AND m.created_at >= ?' : ''}
            ${end_date ? 'AND m.created_at <= ?' : ''}
            ${status ? 'AND m.message_status = ?' : ''}
            GROUP BY 
                m.id, 
                m.instance_id,
                m.recipient,
                m.message,
                m.media,
                m.caption,
                m.message_status,
                m.created_at,
                m.whatsapp_message_id
            ORDER BY m.created_at DESC 
            LIMIT ? OFFSET ?
        `;
        
        const reportParams = [instance_id];
        if (recipient) reportParams.push(`%${recipient.replace(/[+\s-]/g, '')}%`);
        if (start_date) reportParams.push(`${start_date} 00:00:00`);
        if (end_date) reportParams.push(`${end_date} 23:59:59`);
        if (status) reportParams.push(status);
        reportParams.push(parseInt(limit), parseInt(offset));

        // Get total count from media_messages only
        let countQuery = `
            SELECT COUNT(*) as total 
            FROM media_messages 
            WHERE instance_id = ?
            ${recipient ? 'AND recipient LIKE ?' : ''}
            ${start_date ? 'AND created_at >= ?' : ''}
            ${end_date ? 'AND created_at <= ?' : ''}
            ${status ? 'AND message_status = ?' : ''}
        `;
        
        const countParams = [instance_id];
        if (recipient) countParams.push(`%${recipient.replace(/[+\s-]/g, '')}%`);
        if (start_date) countParams.push(`${start_date} 00:00:00`);
        if (end_date) countParams.push(`${end_date} 23:59:59`);
        if (status) countParams.push(status);
        
        const [reportRows] = await connection.query(reportQuery, reportParams);
        const [totalCount] = await connection.query(countQuery, countParams);
        
        // If we have no results, return early
        if (reportRows.length === 0) {
            return res.json({
                success: true,
                reports: [],
                pagination: {
                    total: 0,
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: false
                }
            });
        }
        
        // Process reports
        const reports = reportRows.map((report, index) => ({
            sno: parseInt(offset) + index + 1,
            ...report
        }));
        
        return res.json({
            success: true,
            reports,
            pagination: {
                total: totalCount[0].total,
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: totalCount[0].total > parseInt(offset) + parseInt(limit)
            }
        });
    } catch (error) {
        logger.error('Error in getMessageReports:', error);
        return res.status(500).json({ 
            success: false, 
            message: 'Failed to retrieve message reports',
            error: error.message 
        });
    }
};

/**
 * Get message status summary (count by status)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getMessageStatusSummary = async (req, res) => {
    try {
        const { instance_id } = req.params;
        const { start_date, end_date } = req.query;
        
        const connection = await connectDB();
        
        // Get status summary directly from media_messages
        let query = `
            SELECT 
                COALESCE(message_status, 'pending') as message_status,
                COUNT(*) as count
            FROM media_messages
            WHERE instance_id = ?
            ${start_date ? 'AND created_at >= ?' : ''}
            ${end_date ? 'AND created_at <= ?' : ''}
            GROUP BY message_status
        `;
        
        const queryParams = [instance_id];
        if (start_date) queryParams.push(`${start_date} 00:00:00`);
        if (end_date) queryParams.push(`${end_date} 23:59:59`);
        
        const [rows] = await connection.query(query, queryParams);
        
        const statusSummary = {
            sent: 0,
            delivered: 0,
            read: 0,
            failed: 0,
            pending: 0
        };
        
        rows.forEach(row => {
            if (row.message_status && statusSummary.hasOwnProperty(row.message_status)) {
                statusSummary[row.message_status] = parseInt(row.count) || 0;
            }
        });
        
        res.json({
            success: true,
            summary: statusSummary
        });
    } catch (error) {
        logger.error("Error fetching message status summary:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch message status summary",
            error: error.message
        });
    }
};

/**
 * Get daily message count for a date range
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getDailyMessageCount = async (req, res) => {
    try {
        const { instance_id } = req.params;
        const { start_date, end_date } = req.query;
        
        if (!start_date || !end_date) {
            return res.status(400).json({
                success: false,
                message: "Both start_date and end_date are required"
            });
        }
        
        const connection = await connectDB();
        
        const query = `
            SELECT 
                DATE(m.created_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN m.message_status = 'sent' THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN m.message_status = 'delivered' THEN 1 ELSE 0 END) as delivered,
                SUM(CASE WHEN m.message_status = 'read' THEN 1 ELSE 0 END) as \`read\`,
                SUM(CASE WHEN m.message_status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN m.message_status = 'pending' THEN 1 ELSE 0 END) as pending
            FROM media_messages m
            WHERE m.instance_id = ? AND m.created_at BETWEEN ? AND ?
            GROUP BY DATE(m.created_at)
            ORDER BY DATE(m.created_at)
        `;
        
        const [rows] = await connection.query(query, [instance_id, start_date, end_date]);
        
        res.json({
            success: true,
            dailyCounts: rows
        });
    } catch (error) {
        logger.error("Error fetching daily message count:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch daily message count",
            error: error.message
        });
    }
};
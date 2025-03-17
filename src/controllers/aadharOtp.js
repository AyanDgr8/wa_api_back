// src/controllers/aadharOtp.js

import { logger } from '../logger.js';
import mysql from 'mysql2/promise';
import axios from 'axios'; // Import axios
import { DB_NAME } from '../constants.js';

// Store OTP data for verification with expiration time
const otpStorage = new Map();
const OTP_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds

// Create a single connection pool
const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: DB_NAME,
    port: process.env.MYSQL_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Send OTP to Aadhar-linked mobile number
export const sendAadharOTP = async (req, res) => {
    try {
        const { aadharNumber } = req.body;
        logger.info(`Received OTP request for Aadhar: ${aadharNumber}`);

        // Validate Aadhar number
        if (!aadharNumber || !/^\d{12}$/.test(aadharNumber)) {
            logger.warn(`Invalid Aadhar format: ${aadharNumber}`);
            return res.status(400).json({ 
                success: false,
                message: 'Invalid Aadhar number format. Must be 12 digits.' 
            });
        }

        // Check if an unexpired OTP already exists
        const existingOTP = otpStorage.get(aadharNumber);
        if (existingOTP && (Date.now() - existingOTP.timestamp) < 30000) { // 30 seconds cooldown
            // Only enforce cooldown for resend attempts, not initial registration
            if (req.body.isResend) {
                logger.warn(`OTP request too frequent for Aadhar: ${aadharNumber}`);
                return res.status(429).json({
                    success: false,
                    message: 'Please wait 30 seconds before requesting another OTP'
                });
            }
        }

        // Generate a 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Store OTP with timestamp and expiry
        otpStorage.set(aadharNumber, {
            otp: otp,
            timestamp: Date.now(),
            expiresAt: Date.now() + OTP_EXPIRY_TIME
        });

        logger.info(`Generated OTP for Aadhar: ${aadharNumber} (expires in 5 minutes)`);

        // Call Surepass API to send the actual OTP
        try {
            const surepassResponse = await axios.post(
                `${process.env.SUREPASS_API_URL}/generate-otp`,
                { 
                    id_number: aadharNumber,
                    consent: "Y",
                    purpose: "User verification"
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Store the Surepass client_id if available
            if (surepassResponse.data?.data?.client_id) {
                otpStorage.set(aadharNumber, {
                    ...otpStorage.get(aadharNumber),
                    client_id: surepassResponse.data.data.client_id
                });
            }

        } catch (error) {
            logger.error('Error calling Surepass API:', error.message);
            // Continue even if Surepass API fails
        }

        // Clean up expired OTPs
        for (const [key, value] of otpStorage.entries()) {
            if (Date.now() > value.expiresAt) {
                otpStorage.delete(key);
            }
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully',
            expiresIn: OTP_EXPIRY_TIME / 1000 // Send expiry time in seconds
        });

    } catch (error) {
        logger.error('Error in sendAadharOTP:', error);
        res.status(500).json({ 
            success: false,
            message: 'Failed to send OTP'
        });
    }
};

// Verify OTP and update verification status
export const verifyAadharOTP = async (req, res) => {
    try {
        const { aadharNumber, otp, email } = req.body;
        logger.info(`Verifying OTP for Aadhar: ${aadharNumber}`);

        // Validate inputs
        if (!aadharNumber || !otp || !email) {
            logger.warn('Missing required fields for OTP verification');
            return res.status(400).json({
                success: false,
                message: 'Aadhar number, OTP, and email are required'
            });
        }

        // Get stored OTP data
        const storedData = otpStorage.get(aadharNumber);
        
        if (!storedData) {
            logger.warn(`No OTP found for Aadhar: ${aadharNumber}`);
            return res.status(400).json({
                success: false,
                message: 'Please generate OTP first'
            });
        }

        // Check if OTP has expired
        if (Date.now() > storedData.expiresAt) {
            logger.warn(`Expired OTP for Aadhar: ${aadharNumber}`);
            otpStorage.delete(aadharNumber);
            return res.status(400).json({
                success: false,
                message: 'OTP has expired. Please request a new one.'
            });
        }

        // Check if OTP matches
        if (otp !== storedData.otp) {
            logger.warn(`Invalid OTP attempt for Aadhar: ${aadharNumber}`);
            
            // If we have a Surepass client_id, try verifying with Surepass API
            if (storedData.client_id) {
                try {
                    const surepassResponse = await axios.post(
                        `${process.env.SUREPASS_API_URL}/submit-otp`,
                        {
                            id_number: aadharNumber,
                            otp: otp,
                            client_id: storedData.client_id,
                            consent: "Y"
                        },
                        {
                            headers: {
                                'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
                                'Content-Type': 'application/json'
                            }
                        }
                    );

                    if (!surepassResponse.data?.success) {
                        return res.status(400).json({
                            success: false,
                            message: 'Invalid OTP'
                        });
                    }
                } catch (error) {
                    logger.error('Surepass OTP verification failed:', error.message);
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid OTP'
                    });
                }
            } else {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid OTP'
                });
            }
        }

        // Clear OTP after verification
        otpStorage.delete(aadharNumber);

        try {
            // Get database connection from pool
            const connection = await pool.getConnection();
            
            try {
                // Update user's verification status to 'yes'
                const [result] = await connection.query(
                    'UPDATE register SET verified = ? WHERE email = ?',
                    ['yes', email]
                );

                connection.release();
                
                if (result.affectedRows === 0) {
                    logger.warn(`User not found for email: ${email}`);
                    return res.status(404).json({
                        success: false,
                        message: 'User not found'
                    });
                }

                logger.info(`Successfully verified user with email: ${email}`);
                res.status(200).json({
                    success: true,
                    message: 'OTP verified successfully'
                });
            } catch (dbError) {
                connection.release();
                throw dbError;
            }
        } catch (error) {
            logger.error('Database error:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to update verification status'
            });
        }
    } catch (error) {
        logger.error('Error in verifyAadharOTP:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify OTP'
        });
    }
};

// Update verification status in register table
const updateVerificationStatus = async (email) => {
    let connection;
    try {
        connection = await pool.getConnection();
        
        // Update verified status in register table
        const [updateResult] = await connection.execute(
            `UPDATE register SET verified = 'yes' WHERE email = ?`,
            [email]
        );

        if (updateResult.affectedRows === 0) {
            logger.warn(`No user found with email: ${email}`);
            throw new Error('User not found');
        }

        logger.info(`Verification status updated for user: ${email}`);
        return true;
    } catch (error) {
        logger.error('Error in updateVerificationStatus:', {
            error: error.message,
            email: email
        });
        throw {
            status: error.message === 'User not found' ? 404 : 500,
            message: error.message === 'User not found' ? 
                'User not found in database' : 
                'Failed to update verification status'
        };
    } finally {
        if (connection) {
            connection.release();
        }
    }
};
// src/controllers/kycController.js

import fetch from 'node-fetch';
import connectDB from '../db/index.js';
import bcrypt from 'bcrypt';

const MAX_TOTAL_ATTEMPTS = 3; // Maximum total attempts including resends

const initiateKYC = async (req, res) => {
    try {
        const { 
            uniqueId, 
            uid,
            f_name,
            l_name,
            email,
            phone,
            address,
            company_name,
            password,
            card_select,
            card_detail,
            company_gst,
            isResend = false,
            totalAttempts = 0
        } = req.body;

        // Check total attempts (including current attempt)
        if (totalAttempts >= (isResend ? 2 : 3)) { // For resend, check if we've already had 2 attempts
            return res.status(400).json({
                success: false,
                message: "Maximum attempts reached. Please contact support@voicemeetme.com",
                maxAttemptsExceeded: true,
                redirectTo: "/login"
            });
        }

        // If not a resend request, handle user registration
        if (!isResend) {
            if (!password) {
                return res.status(400).json({
                    success: false,
                    message: 'Password is required for registration'
                });
            }

            // First save/update user registration
            const pool = await connectDB();
            const connection = await pool.getConnection();
            
            try {
                // Hash password
                const hashedPassword = await bcrypt.hash(password, 10);

                // Check if user exists
                const [existingUser] = await connection.query(
                    'SELECT * FROM register WHERE email = ?',
                    [email]
                );

                if (existingUser && existingUser.length > 0) {
                    // Update existing user
                    await connection.query(
                        `UPDATE register SET 
                            password = ?,
                            card_detail = ?,
                            company_gst = ?
                        WHERE email = ?`,
                        [hashedPassword, card_detail, company_gst || 'NOT_PROVIDED', email]
                    );
                } else {
                    // Create new user
                    await connection.query(
                        'INSERT INTO register (username, telephone, email, password, address, card_select, card_detail, company_name, company_gst, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            `${f_name} ${l_name}`,
                            phone,
                            email,
                            hashedPassword,
                            address,
                            card_select,
                            card_detail,
                            company_name || null,
                            company_gst || 'NOT_PROVIDED',
                            'no'
                        ]
                    );
                }
            } finally {
                connection.release();
            }

            // If no Aadhar provided or not using Aadhar, skip KYC
            if (!uid || card_select !== 'Aadhaar') {
                return res.json({
                    success: true,
                    proceedToLogin: true,
                    message: 'Registration successful! Please login to continue.'
                });
            }
        }

        // Proceed with KYC/OTP generation
        if (!uniqueId || !uid) {
            return res.status(400).json({
                success: false,
                message: 'uniqueId and uid are required for OTP generation'
            });
        }

        const response = await fetch('https://svcdemo.digitap.work/ent/v3/kyc/intiate-kyc-auto', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'NjIwNzg0MTk6QmlZTDByV2RXSEF6SGk2WUhvRXVCOTlJQW9BeURpbEg='
            },
            body: JSON.stringify({ uniqueId, uid })
        });
        
        const data = await response.json();
        
        if (data.code === "200") {
            // Ensure we always return the model data for transaction details
            const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
            return res.json({
                ...data,
                success: true,
                message: isResend ? 
                    `OTP resent successfully! (${remainingAttempts} ${remainingAttempts === 1 ? 'attempt' : 'attempts'} remaining)` : 
                    'OTP sent successfully',
                model: {
                    transactionId: data.model?.transactionId,
                    fwdp: data.model?.fwdp,
                    codeVerifier: data.model?.codeVerifier
                },
                remainingAttempts
            });
        } else {
            const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts;
            return res.status(400).json({
                ...data,
                success: false,
                message: isResend ? 'Failed to resend OTP' : 'Failed to send OTP',
                remainingAttempts
            });
        }
    } catch (error) {
        console.error('KYC Initiation Error:', error);
        res.status(500).json({ 
            success: false,
            message: error.message || 'Failed to process request'
        });
    }
};

const submitOTP = async (req, res) => {
    const startTime = Date.now();
    try {
        const { 
            transactionId, 
            fwdp, 
            codeVerifier, 
            otp, 
            shareCode, 
            email, 
            totalAttempts = 0
        } = req.body;
        
        // Check total attempts
        if (totalAttempts >= MAX_TOTAL_ATTEMPTS) {
            // Update user record but keep verified as 'no'
            if (email) {
                const pool = await connectDB();
                const connection = await pool.getConnection();
                try {
                    await connection.query(
                        'UPDATE register SET verified = ? WHERE email = ?',
                        ['no', email]
                    );
                } finally {
                    connection.release();
                }
            }
            
            return res.status(400).json({
                success: false,
                maxAttemptsExceeded: true,
                message: "Maximum attempts reached. Please contact support@voicemeetme.com",
                redirectTo: "/login"
            });
        }

        // Log the request data for debugging
        console.log('OTP Verification Request:', {
            transactionId,
            fwdp,
            codeVerifier,
            otp,
            totalAttempts
        });

        const apiStartTime = Date.now();
        const response = await fetch('https://svcdemo.digitap.work/ent/v3/kyc/submit-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'NjIwNzg0MTk6QmlZTDByV2RXSEF6SGk2WUhvRXVCOTlJQW9BeURpbEg='
            },
            body: JSON.stringify({
                transactionId,
                fwdp,
                codeVerifier,
                otp,
                shareCode,
                isSendPdf: true
            })
        });
        
        const data = await response.json();
        const apiEndTime = Date.now();
        console.log('OTP API Response Time:', apiEndTime - apiStartTime, 'ms');
        
        if (data.code === "200") {
            const pool = await connectDB();
            const connection = await pool.getConnection();
            try {
                const { model } = data;
                
                // Store customer details in database regardless of verification status
                await connection.query(`
                    INSERT INTO customer_details (
                        unique_id, transaction_id, aadhar_number, masked_aadhar_number,
                        name, gender, dob, care_of, pass_code, pdf_link, pdf_img_link,
                        link, house, street, landmark, locality, post_office, district,
                        sub_district, vtc, pincode, state, country
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    model.uniqueId, model.transactionId, model.adharNumber,
                    model.maskedAdharNumber, model.name, model.gender, model.dob,
                    model.careOf, model.passCode, model.pdfLink, model.pdfImgLink,
                    model.link, model.address.house, model.address.street,
                    model.address.landmark, model.address.loc, model.address.po,
                    model.address.dist, model.address.subdist, model.address.vtc,
                    model.address.pc, model.address.state, model.address.country
                ]);

                // Update verification status to 'yes' only on successful verification
                if (email) {
                    await connection.query(
                        'UPDATE register SET verified = ? WHERE email = ?',
                        ['yes', email]
                    );
                }

                const endTime = Date.now();
                console.log('Total OTP Verification Time:', endTime - startTime, 'ms');
                return res.json({
                    ...data,
                    success: true,
                    redirectTo: "/login"
                });
            } finally {
                connection.release();
            }
        } else {
            // Handle specific error codes
            if (data.errorCode === "E0010" || data.errorCode === "E0013") {
                const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
                return res.status(400).json({
                    success: false,
                    remainingAttempts,
                    message: "Incorrect OTP. Please try again.",
                    code: "400"
                });
            }
            
            // Handle other error cases
            const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
            return res.status(400).json({
                ...data,
                success: false,
                remainingAttempts,
                message: data.message
            });
        }
    } catch (error) {
        console.error('OTP Submission Error:', error);
        const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
        return res.status(400).json({ 
            success: false,
            message: "Failed to verify OTP. Please try again.",
            remainingAttempts
        });
    }
};

const resendOTP = async (req, res) => {
    try {
        const { transactionId, email, totalAttempts = 0 } = req.body;

        // Check total attempts (including current attempt)
        if (totalAttempts >= 2) { // Changed from 3 to 2 since this will be another attempt
            return res.status(400).json({
                success: false,
                maxAttemptsExceeded: true,
                message: "Maximum attempts reached. Please contact support@voicemeetme.com",
                redirectTo: "/login"
            });
        }

        const response = await fetch('https://svcdemo.digitap.work/ent/v3/kyc/resend-otp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'NjIwNzg0MTk6QmlZTDByV2RXSEF6SGk2WUhvRXVCOTlJQW9BeURpbEg='
            },
            body: JSON.stringify({ transactionId })
        });

        const data = await response.json();
        const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
        
        return res.json({
            ...data,
            success: data.code === "200",
            remainingAttempts,
            message: data.code === "200" ? 
                'OTP resent successfully!' :
                'Failed to resend OTP.'
        });
    } catch (error) {
        console.error('Resend OTP Error:', error);
        const remainingAttempts = MAX_TOTAL_ATTEMPTS - totalAttempts - 1;
        res.status(500).json({ 
            error: error.message,
            success: false,
            remainingAttempts,
            message: "Failed to resend OTP. Please try again."
        });
    }
};

// Add new endpoint for checking verification status
const checkVerification = async (req, res) => {
    try {
        const pool = await connectDB();
        const connection = await pool.getConnection();

        try {
            // Get instance_id from params
            const instanceId = req.params.instance_id;

            // First, get the user associated with this instance
            const [instances] = await connection.query(
                'SELECT register_id FROM instances WHERE instance_id = ?',
                [instanceId]
            );

            if (instances.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Instance not found',
                    verified: 'no'
                });
            }

            // Get the register_id (email) from instances
            const registerId = instances[0].register_id;

            // Check verification status in register table
            const [rows] = await connection.query(
                'SELECT verified FROM register WHERE email = ?',
                [registerId]
            );

            if (rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found',
                    verified: 'no'
                });
            }

            return res.json({
                success: true,
                verified: rows[0].verified
            });

        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Check Verification Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to check verification status',
            verified: 'no'
        });
    }
};

export { initiateKYC, submitOTP, resendOTP, checkVerification };
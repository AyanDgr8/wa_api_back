// src/controllers/sign.js

import bcrypt from 'bcrypt'; 
import connectDB from '../db/index.js';  
import jwt from 'jsonwebtoken'; 
import dotenv from "dotenv";
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { logger } from '../logger.js';

dotenv.config();  // Load environment variables

// Create nodemailer transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Create a new session
const createSession = async (connection, userId, deviceId) => {
    try {
        // Start transaction
        await connection.beginTransaction();
        
        // Get all active sessions for this user
        const [activeSessions] = await connection.execute(
            'SELECT * FROM login_history WHERE user_id = ? AND is_active = true FOR UPDATE',
            [userId]
        );

        // Mark ALL existing active sessions as inactive, regardless of device
        if (activeSessions.length > 0) {
            await connection.execute(
                'UPDATE login_history SET is_active = false, logout_time = CURRENT_TIMESTAMP() WHERE user_id = ? AND is_active = true',
                [userId]
            );
            
            logger.info(`Deactivated all existing sessions for user ${userId}`);
        }

        // Create new session
        const [result] = await connection.execute(
            'INSERT INTO login_history (user_id, device_id, login_time, is_active, logout_time) VALUES (?, ?, CURRENT_TIMESTAMP(), true, NULL)',
            [userId, deviceId]
        );
        
        // Commit transaction
        await connection.commit();
        
        logger.info(`Created new session ${result.insertId} for user ${userId} with device ${deviceId}`);
        return result.insertId;
    } catch (error) {
        await connection.rollback();
        logger.error(`Error creating session: ${error.message}`);
        throw error;
    }
};

// Validate session
export const validateSession = async (connection, userId, deviceId) => {
    const [session] = await connection.query(
        'SELECT * FROM login_history WHERE user_id = ? AND device_id = ? AND is_active = true AND logout_time IS NULL',
        [userId, deviceId]
    );
    return session.length > 0;
};

// Register User (without role)
export const registerCustomer = async (req, res) => {
    const { username, telephone, email, password, address, 
        card_select, card_detail, 
        company_name, company_gst,
        is_indian_national, passport_base64 } = req.body; 

    // Validate required fields
    if (!username || !telephone || !email || !password || !address || !card_select || 
        (is_indian_national === true && !card_detail) || 
        (is_indian_national === false && !passport_base64)) {
        return res.status(400).json({
            success: false,
            message: 'All required fields must be provided'
        });
    }

    try {
        const connection = await connectDB();
        
        // Check if user exists
        const [existingUser] = await connection.query(
            'SELECT * FROM register WHERE email = ?',
            [email]
        );

        if (existingUser.length === 0) {
            logger.warn(`Registration failed: User not found for email: ${email}`);
            return res.status(404).json({ 
                success: false,
                message: 'Registration not found. Please complete the payment process first.' 
            });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        let passport_file_path = null;

        // Handle passport file upload for non-Indian nationals
        if (is_indian_national === false && passport_base64) {
            // Create directory if it doesn't exist
            const uploadDir = path.join(__dirname, '../../uploads/passports', email);
            fs.mkdirSync(uploadDir, { recursive: true });

            // Convert base64 to file and save
            const matches = passport_base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const fileType = matches[1].split('/')[1];
                const fileName = `passport.${fileType}`;
                passport_file_path = path.join('uploads/passports', email, fileName);
                const filePath = path.join(__dirname, '../../', passport_file_path);

                fs.writeFileSync(filePath, Buffer.from(matches[2], 'base64'));
                logger.info(`Passport file saved for ${email} at ${passport_file_path}`);
            }
        }
    
        // Update the existing user in the 'register' table with all fields
        const [result] = await connection.query(
            `UPDATE register 
             SET password = ?, 
                 card_select = ?, 
                 card_detail = ?,
                 address = ?,
                 company_name = ?,
                 company_gst = ?,
                 username = ?,
                 telephone = ?,
                 is_indian_national = ?,
                 passport_file_path = ?,
             WHERE email = ?`,
            [
                hashedPassword, card_select, card_detail, 
                address, company_name || null, company_gst || null, 
                username, telephone, 
                is_indian_national ? 1 : 0,
                passport_file_path,
                email
            ]
        );

        if (result.affectedRows === 0) {
            logger.error(`Registration update failed for email: ${email}`);
            return res.status(500).json({ 
                success: false,
                message: 'Failed to update registration information' 
            });
        }

        // Return appropriate response based on nationality
        if (!is_indian_national) {
            res.status(200).json({
                success: true,
                message: 'Registration completed successfully. Your passport will be verified shortly.'
            });
        } else {
            res.status(200).json({
                success: true,
                message: 'Registration successful! Please proceed with Aadhaar verification.'
            });
        }

    } catch (error) {
        logger.error(`Registration error for email ${email}: ${error.message}`);
        res.status(500).json({ 
            success: false,
            message: 'Error saving registration information',
            error: error.message 
        });
    }
};

// Login User
export const loginCustomer = async (req, res) => {
    const { email, password } = req.body;
    const deviceId = req.headers['x-device-id'];

    if (!deviceId) {
        return res.status(400).json({ message: 'Device identifier is required' });
    }

    try {
        const pool = await connectDB();
        const connection = await pool.getConnection();

        // Check if the user exists
        const [user] = await connection.query('SELECT * FROM register WHERE email = ?', [email]);
        if (user.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Validate password
        const isValidPassword = await bcrypt.compare(password, user[0].password);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Create new session and invalidate old sessions
        const sessionId = await createSession(connection, user[0].id, deviceId);

        // Generate JWT with session ID and device ID
        const token = jwt.sign(
            { 
                userId: user[0].id, 
                username: user[0].username, 
                email: user[0].email,
                role: user[0].Role,
                deviceId,
                sessionId
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(200).json({ 
            token,
            role: user[0].Role,
            username: user[0].username,
            email: user[0].email
        }); 
    } catch (error) {
        logger.error('Error during login:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Logout User
export const logoutCustomer = async (req, res) => {
    let connection;
    try {
        const pool = await connectDB();
        connection = await pool.getConnection();
        const deviceId = req.headers['x-device-id'];
        const userId = req.user?.userId;

        if (!userId || !deviceId) {
            return res.status(200).json({ message: 'Logged out successfully' });
        }

        // First, get all active sessions for this user
        const [activeSessions] = await connection.execute(
            'SELECT id, device_id FROM login_history WHERE user_id = ? AND is_active = true ORDER BY login_time DESC',
            [userId]
        );

        // Deactivate ALL active sessions for this user
        await connection.execute(
            'UPDATE login_history SET is_active = false, logout_time = CURRENT_TIMESTAMP() WHERE user_id = ? AND is_active = true',
            [userId]
        );

        // Double-check that the sessions were deactivated
        const [verifyDeactivation] = await connection.execute(
            'SELECT COUNT(*) as active_count FROM login_history WHERE user_id = ? AND is_active = true',
            [userId]
        );

        if (verifyDeactivation[0].active_count > 0) {
            // Force deactivation one more time
            await connection.execute(
                'UPDATE login_history SET is_active = false, logout_time = CURRENT_TIMESTAMP() WHERE user_id = ? AND (is_active = true OR logout_time IS NULL)',
                [userId]
            );
        }

        // Log the action
        if (activeSessions.length > 0) {
            logger.info(`Deactivated ${activeSessions.length} sessions for user ${userId}. Initiated from device ${deviceId}`);
        }

        res.status(200).json({ message: 'Logged out successfully' });
    } catch (error) {
        logger.error(`Logout error: ${error.message}`);
        // Emergency cleanup
        try {
            if (connection && req.user?.userId) {
                await connection.execute(
                    'UPDATE login_history SET is_active = false, logout_time = CURRENT_TIMESTAMP() WHERE user_id = ? AND (is_active = true OR logout_time IS NULL)',
                    [req.user.userId]
                );
            }
        } catch (innerError) {
            logger.error(`Failed to cleanup sessions during error handling: ${innerError.message}`);
        }
        res.status(200).json({ message: 'Logged out successfully' });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

// Fetch Current User
export const fetchCurrentUser = async (req, res) => {
    const userId = req.user.userId;  // Assuming you have middleware that attaches user info to req

    try {
        const connection = await connectDB();
        
        // Retrieve the user's information based on their ID
        const [user] = await connection.query('SELECT id, username, email, role FROM users WHERE id = ?', [userId]);
        
        if (user.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Send success response with user information
        res.status(200).json(user[0]);
    } catch (error) {
        console.error('Error fetching current user:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Forgot Password
export const forgotPassword = async (req, res) => {
    const { email } = req.body;

    try {
        const connection = await connectDB();

        // Check if user exists
        const [users] = await connection.query('SELECT id, email, username FROM register WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = users[0];
        
        // Generate a temporary token (this won't be stored in DB)
        const tempToken = crypto.createHash('sha256')
            .update(user.id + user.email + Date.now().toString())
            .digest('hex');

        // Create reset URL
        const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:4000'}/reset-password/${tempToken}`;

        // Send email
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Password Reset Request',
            html: `
                <h1>Password Reset Request</h1>
                <p>Hello ${user.username},</p>
                <p>You requested a password reset. Click the link below to reset your password:</p>
                <a href="${resetUrl}" style="
                    background-color: #EF6F53;
                    color: white;
                    padding: 10px 20px;
                    text-decoration: none;
                    border-radius: 5px;
                    display: inline-block;
                    margin: 20px 0;
                ">Reset Password</a>
                <p>This link will expire in 1 hour.</p>
                <p>If you didn't request this, please ignore this email.</p>
            `
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'Password reset link has been sent to your email' });

    } catch (error) {
        console.error('Error in forgot password:', error);
        res.status(500).json({ message: 'Failed to send reset email' });
    }
};

// Send OTP (Reset Password Link)
export const sendOTP = async (req, res) => {
    try {
        const { email } = req.body;

        const connection = await connectDB();
        
        // Check if the user exists
        const [users] = await connection.query('SELECT * FROM register WHERE email = ?', [email]);
        
        if (users.length === 0) {
            return res.status(400).json({ 
                message: 'The email address you entered is not associated with an account.' 
            });
        }

        const user = users[0];

        // Generate token with user ID
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "20m" });
        const resetLink = `${process.env.FRONTEND_URL}/reset-password/${user.id}/${token}`;

        // Mail options
        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Password Reset Request - MultyComm',
            html: `
                <h2>Password Reset Request</h2>
                <p>Dear ${user.username},</p>
                <p>We received a request to reset your password. Here are your account details:</p>
                <ul>
                    <li>Username: ${user.username}</li>
                    <li>Email: ${email}</li>
                </ul>
                <p>Click the link below to reset your password:</p>
                <a href="${resetLink}" style="display: inline-block; padding: 10px 20px; background-color: #EF6F53; color: white; text-decoration: none; border-radius: 5px;">Reset Password</a>
               
                <p>If you didn't request this password reset, please ignore this email or contact support if you have concerns.</p>
                <p>Best regards,<br>Multycomm Team</p>
            `
        };

        // Send mail using Promise
        await transporter.sendMail(mailOptions);
        return res.status(200).json({ 
            message: 'Password reset link has been sent to your email. Please check your inbox.' 
        });

    } catch (error) {
        console.error('Error sending link:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// Reset Password with Token
export const resetPasswordWithToken = async (req, res) => {
    try {
        const { id, token } = req.params;
        const { newPassword } = req.body;

        // Password validation
        if (!newPassword || newPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters long' });
        }

        // Check for at least one uppercase letter
        if (!/[A-Z]/.test(newPassword)) {
            return res.status(400).json({ message: 'Password must contain at least one uppercase letter' });
        }

        // Check for at least one lowercase letter
        if (!/[a-z]/.test(newPassword)) {
            return res.status(400).json({ message: 'Password must contain at least one lowercase letter' });
        }

        // Check for at least one number
        if (!/\d/.test(newPassword)) {
            return res.status(400).json({ message: 'Password must contain at least one number' });
        }

        // Verify token
        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (err) {
                return res.status(400).json({ message: "Invalid or expired token" });
            }

            // Verify that the token was generated for this user
            if (decoded.userId !== parseInt(id)) {
                return res.status(400).json({ message: "Invalid token for this user" });
            }

            try {
                const connection = await connectDB();
                
                // Hash the new password
                const hashedPassword = await bcrypt.hash(newPassword, 10);
                
                // Update password only - updated_at will be automatically updated
                await connection.query(
                    'UPDATE register SET password = ? WHERE id = ?',
                    [hashedPassword, id]
                );

                res.status(200).json({ message: 'Password reset successful' });
            } catch (error) {
                console.error('Error updating password:', error);
                res.status(500).json({ message: 'Failed to update password' });
            }
        });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// Reset Password
export const resetPassword = async (req, res) => {
    const { email, newPassword } = req.body;

    try {
        const connection = await connectDB();

        // Find user by email
        const [users] = await connection.query('SELECT * FROM register WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(400).json({ message: 'User not found' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password
        await connection.query(
            'UPDATE register SET password = ? WHERE email = ?',
            [hashedPassword, email]
        );

        res.status(200).json({ message: 'Password reset successful' });

    } catch (error) {
        console.error('Error in reset password:', error);
        res.status(500).json({ message: 'Failed to reset password' });
    }
};

// Save Password
export const savePassword = async (req, res) => {
    try {
        const { email, password, username, telephone, address, card_select, card_detail, company_name, company_gst } = req.body;

        // Log received data (excluding password)
        logger.info('Received registration data:', {
            email,
            username,
            telephone,
            address,
            card_select,
            card_detail,
            company_name,
            company_gst
        });

        // Validate all required fields
        if (!email || !password || !username || !telephone || !address) {
            return res.status(400).json({
                success: false,
                message: 'All required fields must be provided: email, password, username, telephone, and address'
            });
        }

        // Force card_select to be Aadhaar
        const finalCardSelect = 'Aadhaar';
        const finalCardDetail = card_detail || 'NOT_PROVIDED';

        const connection = await connectDB();
        
        try {
            // First check if user exists
            const [existingUser] = await connection.query(
                'SELECT * FROM register WHERE email = ?',
                [email]
            );

            // Hash the password
            const hashedPassword = await bcrypt.hash(password, 10);

            // Log the query parameters (excluding password)
            logger.info('Saving user with parameters:', {
                email,
                username,
                telephone,
                address,
                card_select: finalCardSelect,
                card_detail: finalCardDetail,
                company_name: company_name || null,
                company_gst: company_gst || null
            });

            if (existingUser.length > 0) {
                // Update existing user
                const updateQuery = `
                    UPDATE register 
                    SET password = ?,
                        username = ?,
                        telephone = ?,
                        address = ?,
                        card_select = ?,
                        card_detail = ?,
                        company_name = ?,
                        company_gst = ?
                    WHERE email = ?
                `;

                await connection.query(
                    updateQuery,
                    [
                        hashedPassword,
                        username,
                        telephone,
                        address,
                        finalCardSelect,
                        finalCardDetail,
                        company_name || null,
                        company_gst || null,
                        email
                    ]
                );
            } else {
                // Insert new user
                const insertQuery = `
                    INSERT INTO register (
                        email, password, username, telephone, address, 
                        card_select, card_detail, company_name, company_gst
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

                await connection.query(
                    insertQuery,
                    [
                        email,
                        hashedPassword,
                        username,
                        telephone,
                        address,
                        finalCardSelect,
                        finalCardDetail,
                        company_name || null,
                        company_gst || null
                    ]
                );
            }

            // Log success
            logger.info('Successfully saved user:', { email });

            return res.status(200).json({
                success: true,
                message: 'Password and user details saved successfully'
            });
        } catch (dbError) {
            logger.error('Database error while saving password:', {
                error: dbError.message,
                email: email
            });
            throw dbError;
        }
    } catch (error) {
        logger.error('Error saving password:', {
            error: error.message,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            success: false,
            message: 'Failed to save password',
            error: error.message
        });
    }
};

// Check if user is already registered
export const checkRegistration = async (req, res) => {
    const { email } = req.params;
    
    try {
        const connection = await connectDB();
        
        // Check if email exists in register table and has a password set
        const [rows] = await connection.query(
            'SELECT id FROM register WHERE email = ? AND password IS NOT NULL AND password != ""',
            [email]
        );

        return res.status(200).json({
            isRegistered: rows.length > 0
        });

    } catch (error) {
        console.error('Error checking registration:', error);
        res.status(500).json({ message: 'Error checking registration status' });
    }
};

// Check if user has password and is verified
export const checkUserPassword = async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const connection = await connectDB();
        
        try {
            const [users] = await connection.query(
                'SELECT verified, password FROM register WHERE email = ?',
                [email]
            );

            if (users.length === 0) {
                return res.status(200).json({
                    success: true,
                    verified: 'no',
                    hasPassword: false
                });
            }

            const user = users[0];
            return res.status(200).json({
                success: true,
                verified: user.verified,
                hasPassword: Boolean(user.password)
            });

        } catch (dbError) {
            logger.error('Database error while checking user password:', {
                error: dbError.message,
                email
            });
            throw dbError;
        }
    } catch (error) {
        logger.error('Error checking user password:', {
            error: error.message,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            success: false,
            message: 'Failed to check user password status',
            error: error.message
        });
    }
};

// Check session status
export const checkSession = async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const deviceId = req.headers['x-device-id'];

    if (!token || !deviceId) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required',
            forceLogout: true
        });
    }

    let connection;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const pool = await connectDB();
        connection = await pool.getConnection();

        // Get the latest active session for this user
        const [sessions] = await connection.execute(
            'SELECT * FROM login_history WHERE user_id = ? AND is_active = true ORDER BY login_time DESC LIMIT 1',
            [decoded.userId]
        );

        if (sessions.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'No active session found',
                forceLogout: true
            });
        }

        const latestSession = sessions[0];

        // Check if this device is the latest active session
        if (latestSession.device_id !== deviceId || latestSession.id !== decoded.sessionId) {
            return res.status(401).json({
                success: false,
                message: 'Session invalidated due to login from another device',
                forceLogout: true
            });
        }

        // Session is valid
        res.status(200).json({
            success: true,
            message: 'Session is valid'
        });
    } catch (error) {
        logger.error(`Check session error: ${error.message}`);
        res.status(401).json({
            success: false,
            message: 'Session validation failed',
            forceLogout: true
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};
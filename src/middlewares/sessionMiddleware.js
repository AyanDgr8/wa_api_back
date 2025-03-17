// src/middleware/sessionMiddleware.js
import connectDB from '../db/index.js';
import jwt from 'jsonwebtoken';
import { logger } from '../logger.js';

export const validateSession = async (req, res, next) => {
    // List of paths that don't require session validation
    const excludedPaths = ['/login', '/logout', '/check-session'];
    
    if (excludedPaths.includes(req.path)) {
        return next();
    }

    const token = req.headers.authorization?.split(' ')[1];
    const deviceId = req.headers['x-device-id'];

    if (!token || !deviceId) {
        logger.warn('Missing token or device ID');
        return res.status(401).json({ 
            message: 'Authentication required',
            forceLogout: true
        });
    }

    let connection;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        connection = await connectDB();

        await connection.beginTransaction();

        // Get all active sessions for this user, ordered by login time
        const [sessions] = await connection.execute(
            'SELECT * FROM login_history WHERE user_id = ? AND is_active = true ORDER BY login_time DESC FOR UPDATE',
            [decoded.userId]
        );

        if (sessions.length === 0) {
            logger.warn(`No active sessions found for user ${decoded.userId}`);
            await connection.commit();
            return res.status(401).json({ 
                message: 'Session expired. Please login again',
                forceLogout: true
            });
        }

        // Get the latest active session
        const latestSession = sessions[0];

        // If current device is not the latest session, force logout
        if (latestSession.device_id !== deviceId || latestSession.id !== decoded.sessionId) {
            await connection.commit();
            logger.warn(`User ${decoded.userId} attempted to access with non-latest device ${deviceId}. Latest device is ${latestSession.device_id}`);
            return res.status(401).json({ 
                message: 'You have been logged in from another device',
                forceLogout: true
            });
        }

        await connection.commit();
        req.user = decoded;
        next();
    } catch (error) {
        if (connection) {
            await connection.rollback();
        }
        logger.error(`Session validation error: ${error.message}`);
        return res.status(401).json({ 
            message: 'Session validation failed',
            forceLogout: true
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};
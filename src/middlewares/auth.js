// src/middlewares/auth.js

import jwt from 'jsonwebtoken';
import dotenv from "dotenv";
import { instances } from '../controllers/qrcode.js';
import connectDB from '../db/index.js';
dotenv.config();  // Load environment variables

export const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(403).json({ message: "Access denied. No token provided." });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = { 
            userId: decoded.userId, 
            username: decoded.username,
            email: decoded.email,  
            role: decoded.role, 
            instance_id: decoded.instance_id
        };
        next();
    } catch (error) {
        console.error("Token verification failed:", error); // Debug log
        return res.status(401).json({ message: "Invalid token." });
    }
};

// Middleware to attach WhatsApp instance to request
export const attachWhatsAppInstance = async (req, res, next) => {
    try {
        const instanceId = req.params.instanceId || req.body.instanceId;
        
        if (!instanceId) {
            return res.status(400).json({ message: "Instance ID is required" });
        }

        // Get instance from memory
        const instance = instances[instanceId];
        const hasSock = instance && instance.sock;
        
        if (!instance || !hasSock) {
            console.log('WhatsApp instance check failed:', {
                instanceExists: !!instance,
                hasSock: hasSock,
                instanceId,
                availableInstances: Object.keys(instances)
            });
            return res.status(400).json({ message: 'WhatsApp instance not connected' });
        }

        // Verify instance ownership from database
        const connection = await connectDB();
        const [rows] = await connection.execute(
            'SELECT * FROM instances WHERE instance_id = ?',
            [instanceId]
        );

        if (rows.length === 0) {
            return res.status(403).json({ message: 'Access denied. Instance does not belong to user.' });
        }

        req.sock = instance.sock;
        req.instanceId = instanceId;
        next();
    } catch (error) {
        console.error('Error in attachWhatsAppInstance middleware:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
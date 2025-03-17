// src/controllers/qrcode.js

import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode';
import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { logger } from '../logger.js';
// In qrcode.js, import the setupMessageStatusTracking
import { setupMessageStatusTracking } from './updateStatus.js';

// Store active instances
export const instances = {};

// Initialize WhatsApp connection for a specific instance
export const initializeSock = async (instanceId) => {
    try {
        logger.info(`Initializing WhatsApp connection for instance ${instanceId}`);
        
        const userDir = path.join(process.cwd(), 'users');
        const authFolder = path.join(userDir, `instance_${instanceId}`);

        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir);
        if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);

        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        // Initialize WhatsApp socket with required options
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // qr code in terminal
            browser: ["Chrome (Linux)", "", ""], // This helps avoid detection
            connectTimeoutMs: 120000, // Increased from 60000
            defaultQueryTimeoutMs: 90000, // Increased from 60000
            keepAliveIntervalMs: 15000,
            emitOwnEvents: true,
            markOnlineOnConnect: true, // Don't mark as online automatically
            retryRequestDelayMs: 500,
            // logger: { // Configure custom logger
            //     info: () => {}, // Suppress info logs
            //     debug: () => {}, // Suppress debug logs
            //     warn: (msg) => logger.warn(msg), // Only log warnings
            //     error: (msg) => logger.error(msg) // And errors
            // }
        });

        // Setup message status tracking
        setupMessageStatusTracking(sock, instanceId);

        // Save credentials whenever updated
        sock.ev.on('creds.update', saveCreds);

        // Create a promise that resolves when QR code is generated or connection is established
        const connectionPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 120000); // 2 minutes

            let hasResolved = false;

            // Handle connection updates
            sock.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect } = update;
                
                // Safe check for disconnect reason
                let statusCode = null;
                if (lastDisconnect && 
                    lastDisconnect.error && 
                    lastDisconnect.error.output && 
                    lastDisconnect.error.output.statusCode) {
                    statusCode = lastDisconnect.error.output.statusCode;
                }
                
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                logger.info('Connection update:', { update });

                if (qr && !hasResolved) {
                    logger.info(`Generating QR code for instance ${instanceId}`);
                    try {
                        const url = await qrcode.toDataURL(qr);
                        logger.debug('QR Code URL generated successfully');
                        
                        instances[instanceId] = {
                            sock,
                            qrCode: url,
                            status: 'disconnected',
                            lastUpdate: new Date()
                        };
                        
                        if (!hasResolved) {
                            resolve({ qrCode: url });
                            hasResolved = true;
                        }
                    } catch (err) {
                        logger.error('Error generating QR code URL:', { error: err.message, stack: err.stack });
                        reject(err);
                    }
                }

                if (connection === 'open') {
                    logger.info(`Connection opened for instance ${instanceId}`);
                    clearTimeout(timeout);
                    
                    instances[instanceId] = {
                        sock,
                        status: 'connected',
                        lastUpdate: new Date()
                    };

                    // Save the auth state immediately when connected
                    await saveCreds();

                    if (!hasResolved) {
                        resolve({ connected: true });
                        hasResolved = true;
                    }
                }

                if (connection === 'close') {
                    // Safe check for disconnect reason
                    let statusCode = null;
                    if (lastDisconnect && 
                        lastDisconnect.error && 
                        lastDisconnect.error.output && 
                        lastDisconnect.error.output.statusCode) {
                        statusCode = lastDisconnect.error.output.statusCode;
                    }

                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    // Safe error logging
                    const errorDetails = lastDisconnect && lastDisconnect.error ? lastDisconnect.error : 'Unknown error';
                    logger.warn('Connection closed:', { 
                        error: errorDetails, 
                        shouldReconnect,
                        instanceId 
                    });
                    
                    if (shouldReconnect) {
                        instances[instanceId] = {
                            ...instances[instanceId],
                            status: 'reconnecting',
                            lastUpdate: new Date()
                        };
                        
                        // Instead of recursive call, use setTimeout to attempt reconnection
                        setTimeout(async () => {
                            try {
                                const instance = instances[instanceId] || {};
                                const currentSock = instance.sock;
                                // Only reconnect if this is still the current socket
                                if (currentSock === sock) {
                                    // Save the current state before reconnecting
                                    await saveCreds();
                                    delete instances[instanceId];
                                    await initializeSock(instanceId);
                                }
                            } catch (error) {
                                logger.error('Error during reconnection:', { 
                                    error: error.message, 
                                    stack: error.stack,
                                    instanceId 
                                });
                            }
                        }, 5000); // Wait 5 seconds before reconnecting
                    } else {
                        instances[instanceId] = {
                            ...instances[instanceId],
                            status: 'disconnected',
                            lastUpdate: new Date()
                        };
                        if (!hasResolved) {
                            reject(new Error('Connection closed'));
                        }
                    }
                }
            });

            // Handle messages
            sock.ev.on('messages.upsert', (m) => {
                logger.info('Got message:', { messages: m });
            });

            // Handle connection events
            sock.ev.on('connection.update', (update) => {
                logger.info('Connection state update:', { update });
            });

            // Handle credentials update
            sock.ev.on('creds.update', () => {
                logger.debug('Credentials updated');
            });
        });

        return connectionPromise;
    } catch (error) {
        logger.error('Error in initializeSock:', { error: error.message, stack: error.stack });
        throw error;
    }
};

// Generate QR code endpoint handler
export const generateQRCode = async (req, res) => {
    try {
        const instanceId = req.params.id;
        logger.info(`Generating QR code for instance ${instanceId}`);

        // Check if instance exists
        const existingInstance = instances[instanceId];

        // If instance exists and is connected, return authenticated status
        if (existingInstance && existingInstance.status === 'connected') {
            return res.json({ isAuthenticated: true });
        }

        // Perform cleanup if there's an existing instance (regardless of status)
        if (existingInstance) {
            logger.info(`Cleaning up existing instance ${instanceId} (Status: ${existingInstance.status || 'unknown'})`);
            try {
                // Ensure proper socket cleanup
                if (existingInstance.sock) {
                    try {
                        await existingInstance.sock.logout().catch(e => logger.error('Logout error:', { error: e.message, stack: e.stack }));
                        await existingInstance.sock.end().catch(e => logger.error('End error:', { error: e.message, stack: e.stack }));
                    } catch (socketError) {
                        logger.error('Socket cleanup error:', { error: socketError.message, stack: socketError.stack });
                    }
                }

                // Remove instance from memory
                delete instances[instanceId];
                
                // Clean up auth files
                const authFolder = path.join(process.cwd(), 'users', `instance_${instanceId}`);
                if (fs.existsSync(authFolder)) {
                    try {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                        logger.info(`Auth folder cleaned up: ${authFolder}`);
                    } catch (fsError) {
                        logger.error('Auth folder cleanup error:', { error: fsError.message, stack: fsError.stack });
                    }
                }
                
                // Wait for cleanup to complete
                await new Promise(resolve => setTimeout(resolve, 5000));
                logger.info('Cleanup completed successfully');
            } catch (cleanupError) {
                logger.error('Cleanup operation failed:', { error: cleanupError.message, stack: cleanupError.stack });
                // Continue with new instance creation even if cleanup fails
            }
        }

        // Initialize new connection with retry logic
        let retryCount = 0;
        const maxRetries = 3;
        let lastError = null;

        while (retryCount < maxRetries) {
            try {
                logger.info(`Attempt ${retryCount + 1} to initialize WhatsApp connection`);
                
                // Double check that instance is cleaned up before proceeding
                if (instances[instanceId]) {
                    logger.info('Found lingering instance, cleaning up again...');
                    delete instances[instanceId];
                }

                const result = await initializeSock(instanceId);
                
                if (result.connected) {
                    return res.json({ isAuthenticated: true });
                }

                if (result.qrCode) {
                    return res.json({ qrCode: result.qrCode });
                }

                throw new Error('Failed to generate QR code or establish connection');
            } catch (error) {
                logger.error(`Attempt ${retryCount + 1} failed:`, { error: error.message, stack: error.stack });
                lastError = error;
                retryCount++;
                
                if (retryCount < maxRetries) {
                    const waitTime = 3000 * (retryCount + 1); // Exponential backoff
                    logger.info(`Waiting ${waitTime}ms before retry ${retryCount + 1}...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }

        // Handle error if QR code generation fails after max retries
        if (!result.qrCode) {
            const errorMessage = lastError ? lastError.message : 'Unknown error';
            throw new Error(`Failed to generate QR code after ${maxRetries} attempts: ${errorMessage}`);
        }
    } catch (error) {
        logger.error('Error in generateQRCode:', { error: error.message, stack: error.stack });
        res.status(500).json({ 
            error: error.message,
            status: 'error',
            message: 'Failed to generate QR code, please try again'
        });
    }
};

// Get connection status endpoint handler
export const getConnectionStatus = async (req, res) => {
    try {
        const instanceId = req.params.id;
        const instance = instances[instanceId];

        if (!instance) {
            return res.status(404).json({ 
                success: false,
                connected: false,
                status: 'not_found',
                message: 'Instance not found'
            });
        }

        const isConnected = instance.sock && instance.sock.user;
        let status = instance.status;
        let message = '';

        // Determine detailed status and message
        if (isConnected) {
            status = 'connected';
            message = 'WhatsApp is connected';
        } else if (status === 'reconnecting') {
            message = 'WhatsApp is reconnecting...';
        } else {
            status = 'disconnected';
            message = 'WhatsApp is not connected';
        }

        res.json({
            success: true,
            connected: isConnected,
            status: status,
            message: message,
            lastUpdate: instance.lastUpdate
        });
    } catch (error) {
        logger.error('Error in getConnectionStatus:', { error: error.message, stack: error.stack });
        res.status(500).json({ 
            success: false,
            connected: false,
            status: 'error',
            message: error.message || 'Failed to check WhatsApp connection status',
            lastUpdate: new Date()
        });
    }
};

// Reset instance endpoint handler
export const resetInstance = async (req, res) => {
    try {
        const instanceId = req.params.id;
        const instance = instances[instanceId];

        if (instance && instance.sock) {
            // Close the existing connection
            await instance.sock.logout();
            await instance.sock.end();
            delete instances[instanceId];
        }

        // Delete auth files
        const authFolder = path.join(process.cwd(), 'users', `instance_${instanceId}`);
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
        }

        res.json({ success: true, message: 'Instance reset successfully' });
    } catch (error) {
        logger.error('Error in resetInstance:', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
    }
};
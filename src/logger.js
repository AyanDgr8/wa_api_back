// src/logger.js

import winston from 'winston';
import 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';

// Create a log directory if it doesn't exist
const logDir = 'logs';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Determine whether to log to console based on environment
const isProduction = process.env.NODE_ENV === 'production';

// Function to format the date for filename
const getFormattedDate = () => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `${day}_${month}_${year}`;
};

// Create a custom logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        // Rotating file transport for errors
        new winston.transports.DailyRotateFile({
            filename: path.join(logDir, 'error_%DATE%.log'),
            datePattern: 'DD_MM_YYYY',
            maxSize: '20m',
            level: 'error',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            maxFiles: '30d' // Keep logs for 30 days
        }),
        // Rotating file transport for combined logs
        new winston.transports.DailyRotateFile({
            filename: path.join(logDir, 'combined_%DATE%.log'),
            datePattern: 'DD_MM_YYYY',
            maxSize: '20m',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            maxFiles: '30d' // Keep logs for 30 days
        }),
        // Rotating file transport for exception logs
        new winston.transports.DailyRotateFile({
            filename: path.join(logDir, 'exception_%DATE%.log'),
            datePattern: 'DD_MM_YYYY',
            maxSize: '20m',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.json()
            ),
            maxFiles: '30d' // Keep logs for 30 days
        })
    ],
});

// Add console transport only in non-production environments
if (!isProduction) {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

export { logger };

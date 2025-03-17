// src/app.js

import express from "express";
import cors from "cors";
import router from './routes/router.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandling.js';
import fileUpload from "express-fileupload";

// import morgan from "morgan"; 
import { logger } from './logger.js';
import { initializeScheduler } from './controllers/schedule.js';

const app = express();

const allowedOrigins = ['http://localhost:3000', 'https://localhost:3000', 
                        'http://localhost:4000', 'https://localhost:4000',
                        'http://10.5.50.245:9999','http://localhost:9999',
                        'http://localhost:8888', 'https://localhost:8888',
                        'http://172.20.10.3:9999', 'http://10.5.48.100:9999',
                        'https://10.5.50.245:9999','https://localhost:9999',
                        'http://217.145.69.251:9999', 'https://217.145.69.251:9999',
                        'http://192.168.150.146:9999', 'https://192.168.150.146:9999',
                        'https://217.145.69.239:9999', 'http://217.145.69.239:9999',
                        'https://login.watsapp.shop','http://login.watsapp.shop',
                        'https://login.watsapp.shop:9999','http://login.watsapp.shop:9999'
                      ]; // Add frontend URL

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin, like mobile apps or curl requests
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  // origin: true,
  credentials: true, // Allow credentials
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

// // Use Morgan for logging HTTP requests
// app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

app.use("/", router);

// Initialize the message scheduler
initializeScheduler();

// Middleware for handling 404 errors
app.use(notFoundHandler);

// Middleware for handling errors
app.use(errorHandler);

// Global error handling
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export { app };
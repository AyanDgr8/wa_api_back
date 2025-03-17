// src/index.js

import dotenv from "dotenv";
import http from "http";
import connectDB from "./db/index.js";
import { app } from './app.js';
import 'colors';
// import { logger } from "./logger.js";

dotenv.config({
  path: './.env'
});

// Verify necessary environment variables
if (!process.env.PORT) {
  console.error("❌ PORT environment variable is missing. Please set it in the .env file.".red.bold);
  process.exit(1);
}

// Load SSL certificates with error handling
// let sslOptions;
// try {
//   sslOptions = {
//     key: fs.readFileSync('ssl/apache-selfsigned.key'),   // Replace with actual path to your private key
//     cert: fs.readFileSync('ssl/apache-selfsigned.crt')   // Replace with actual path to your SSL certificate
//   };
// } catch (error) {
//   console.error("❌ Error loading SSL certificates. Check paths and permissions.".red.bold, error);
//   process.exit(1);
// }

// Create HTTP server
const server = http.createServer(app);

// Initialize the connection pool
const pool = connectDB();

const startServer = async () => {
  try {
    await server.listen(process.env.PORT);
    console.log(`⚙️  Secure server is running on port: ${process.env.PORT}`.cyan.bold);
  } catch (error) {
    console.error("❌ Error starting server:", error);
    process.exit(1);
  }
};

process.title = 'MultyComm Whatsapp Messenger';

// Graceful shutdown function
const gracefulShutdown = async () => {
  console.log('📢 Received shutdown signal, closing server and database connections...'.yellow.bold);
  
  // Close the pool
  await pool.end().catch(err => console.error('Error closing MySQL pool:', err));
  
  server.close(() => {
    console.log('💤 Secure server closed successfully.'.blue.bold);
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Global error handling
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:'.red.bold);
  console.error(err);
  // Log the error but don't exit the process
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:'.red.bold, promise);
  console.error('Reason:', reason);
  // Log the error but don't exit the process
});

// Add specific WhatsApp error handling
process.on('SIGABRT', () => {
  console.log('🔄 WhatsApp connection reset detected, handling gracefully...'.yellow.bold);
  // Don't exit the process, let WhatsApp client handle reconnection
});

// Connect to MySQL and start server
const initApp = async () => {
  try {
    // Test the pool connection
    const connection = await pool.getConnection();
    connection.release(); // Release the connection back to the pool

    console.log(`🔌 MySQL connected`.green.bold);
    await startServer();
  } catch (err) {
    console.log("MySQL connection failed !!! ".red.bold, err);
    process.exit(1);
  }
};

initApp();

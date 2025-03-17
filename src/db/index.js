// src/db/index.js

import mysql from 'mysql2/promise';
import { DB_NAME } from "../constants.js";

let pool;

// Initialize the connection pool
const connectDB = () => {
  try {
    if (!pool) {
      pool = mysql.createPool({
        host: process.env.MYSQL_HOST,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: DB_NAME,
        port: process.env.MYSQL_PORT,
      });
      console.log(`\nMySQL connection pool created! DB HOST: ${process.env.MYSQL_HOST}`);

      // Database health check
      pool.query('SELECT 1')
        .then(() => console.log('✅ Database connection is healthy.'))
        .catch(err => console.error('Database health check failed:', err));

    }
    return pool;
    
  } catch (error) {
    console.error("MySQL connection pool creation FAILED:", error.message);
    throw error;
  }
};

export default connectDB;

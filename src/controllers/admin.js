// src/controllers/admin.js

import connectDB from '../db/index.js';  

// Function to make a user an admin based on their username
export const makeAdminByUsername = async (username) => {
    if (!username) {
        console.error("Username is required to update user role.");
        return { success: false, message: "Username is required." };
    }
    try {
        const connection = await connectDB();
        
        const sqlUpdate = "UPDATE users SET role = 'Admin' WHERE username = ?";
        const [result] = await connection.query(sqlUpdate, [username]);

        // Check if any rows were affected
        if (result.affectedRows === 0) {
            console.warn(`No user found with username: ${username}`);
            return { success: false, message: "User not found." };
        }

        return { success: true, message: "User has been promoted to Admin successfully." };
    } catch (error) {
        console.error("Error updating user role:", error);
        return { success: false, message: "Internal server error." };
    } 
};




// To promote adimn 
// https://crm.voicemeetme.net:8443/promote-admin


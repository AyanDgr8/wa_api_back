// src/controllers/instances.js

import connectDB from "../db/index.js";

// Function to save instance state to the database
export const saveInstanceToDB = async (req, res) => {
    const { instance_id, register_id } = req.body;

    if (!register_id) {
        return res.status(401).json({ message: "Unauthorized: User not logged in" });
    }

    if (!instance_id || instance_id.length < 4) {
        return res.status(400).json({ message: "Invalid Instance ID. Minimum length is 4 characters" });
    }

    try {
        const connection = await connectDB();

        // Check if the user exists in the `register` table
        const [userExists] = await connection.query(
            "SELECT email FROM register WHERE email = ?",
            [register_id]
        );

        if (userExists.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        // Check if the instance ID already exists
        const [existingInstances] = await connection.query(
            "SELECT * FROM instances WHERE instance_id = ?",
            [instance_id]
        );

        if (existingInstances.length > 0) {
            return res.status(400).json({ message: "Instance ID already exists" });
        }

        // Insert the new instance into the `instances` table
        const [result] = await connection.query(
            "INSERT INTO instances (register_id, instance_id) VALUES (?, ?)",
            [register_id, instance_id]
        );

        res.status(201).json({
            message: "Instance saved successfully",
            instance_id,
        });
    } catch (error) {
        console.error("Error saving instance:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

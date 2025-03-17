// src/middleware/adminMiddleware.js

export const adminMiddleware = (req, res, next) => {
    // Logic to check if the user is an admin
    if (req.user && req.user.role === 'Admin') {
        next(); // Proceed to the next middleware or route handler
    } else {
        return res.status(403).json({ message: 'Access denied.' }); // Forbidden
    }
};

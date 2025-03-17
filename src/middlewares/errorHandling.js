// src/middlewares/errorHandling.js

export const errorHandler = (err, req, res, next) => {
  console.log(err.message); // Log the error message
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
};

export const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Resource not found',
  });
};
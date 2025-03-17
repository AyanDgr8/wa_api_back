// src/controllers/fileUpload.js

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { saveCSVDataToDB } from './saveNumbers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Handle media upload
export const uploadMedia = async (req, res) => {
    console.log('Received request to upload media');
    console.log('Request params:', req.params);
    console.log('Request files:', req.files);

    try {
        // Check if instance ID exists in params
        const instanceId = req.params.id;
        console.log('Extracted instance ID:', instanceId);

        if (!instanceId) {
            console.log('No instance ID found in params');
            return res.status(400).json({ message: 'Instance ID is required' });
        }

        // Check if file exists
        if (!req.files || !req.files.file) {
            console.log('No file found in request');
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const uploadedFile = req.files.file;
        console.log('File details:', {
            name: uploadedFile.name,
            size: uploadedFile.size,
            mimetype: uploadedFile.mimetype
        });

        const fileExtension = path.extname(uploadedFile.name).toLowerCase();
        
        // Define allowed extensions for different purposes
        const whatsappCompatibleExtensions = ['.jpg', '.jpeg', '.png', '.mp4', '.mp3', '.pdf', '.doc', '.docx'];
        const dataFileExtensions = ['.xls', '.xlsx', '.csv'];
        const allowedExtensions = [...whatsappCompatibleExtensions, ...dataFileExtensions];

        if (!allowedExtensions.includes(fileExtension)) {
            console.log('Invalid file type:', fileExtension);
            return res.status(400).json({ message: 'Unsupported file format' });
        }

        // Create a unique filename
        const uniqueFilename = `${Date.now()}-${uploadedFile.name}`;
        console.log('Generated filename:', uniqueFilename);
        
        // Define the absolute path
        const uploadPath = path.join(__dirname, '..', '..', 'uploads', 'media', instanceId, uniqueFilename);
        console.log('Upload path:', uploadPath);

        try {
            // Ensure the directory exists
            await fs.promises.mkdir(path.dirname(uploadPath), { recursive: true });

            // Move the file to the target location
            await uploadedFile.mv(uploadPath);

            // Send success response with file details and compatibility info
            res.status(200).json({ 
                success: true,
                message: 'File uploaded successfully',
                filePath: uploadPath,
                originalName: uploadedFile.name,
                size: uploadedFile.size,
                isWhatsAppCompatible: whatsappCompatibleExtensions.includes(fileExtension),
                fileType: fileExtension
            });

        } catch (fileError) {
            console.error('Error saving file:', fileError);
            res.status(500).json({ message: 'Failed to save file' });
        }

    } catch (error) {
        console.error('Error in uploadMedia:', error);
        res.status(500).json({ message: 'Internal server error during media upload' });
    }
};

// Handle CSV upload
export const uploadCSV = async (req, res) => {
    console.log('Received request to upload CSV');
    console.log('Request params:', req.params);
    console.log('Request files:', req.files);

    try {
        // Check if instance ID exists in params
        const instanceId = req.params.id;  
        console.log('Extracted instance ID:', instanceId);

        if (!instanceId) { 
            console.log('No instance ID found in params');
            return res.status(400).json({ message: 'Instance ID is required' });
        }

        // Check if file exists
        if (!req.files || !req.files.file) {
            console.log('No file found in request');
            return res.status(400).json({ message: 'No CSV file uploaded' });
        }

        const uploadedFile = req.files.file;
        console.log('File details:', {
            name: uploadedFile.name,
            size: uploadedFile.size,
            mimetype: uploadedFile.mimetype
        });

        // Validate file size (max 5MB)
        const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes
        if (uploadedFile.size > MAX_FILE_SIZE) {
            console.log('File too large:', uploadedFile.size);
            return res.status(400).json({ message: 'File size exceeds 5MB limit' });
        }

        // Get file extension
        const fileExtension = path.extname(uploadedFile.name).toLowerCase();
        
        // Validate file type
        const allowedExtensions = ['.csv', '.xls', '.xlsx'];
        if (!allowedExtensions.includes(fileExtension)) {
            console.log('Invalid file type:', uploadedFile.name);
            return res.status(400).json({ 
                message: 'Only CSV and Excel files (.csv, .xls, .xlsx) are allowed',
                allowedFormats: allowedExtensions
            });
        }
        
        // Define the absolute path
        const uploadPath = path.join(__dirname, '..', '..', 'uploads', 'list', instanceId, uploadedFile.name);
        console.log('Upload path:', uploadPath);

        try {
            try {
                // Create upload directory
                console.log('Creating directory:', path.dirname(uploadPath));
                await fs.promises.mkdir(path.dirname(uploadPath), { recursive: true });
                
                // Move file to upload location
                console.log('Moving file to:', uploadPath);
                await uploadedFile.mv(uploadPath);
                
                // Set instanceId in req.params for database save
                req.params.instanceId = instanceId;
                
                console.log('Processing file with extension:', fileExtension);
                
                // For Excel files, ensure we have the raw buffer data
                if (fileExtension === '.xlsx' || fileExtension === '.xls') {
                    console.log('Reading Excel file directly from buffer');
                    const fileBuffer = await fs.promises.readFile(uploadPath);
                    req.files.file.data = fileBuffer;
                    console.log('Excel file buffer size:', fileBuffer.length, 'bytes');
                }
                
                // Process the file data
                console.log('Passing file to saveCSVDataToDB...');
                const dbResult = await saveCSVDataToDB(req);
                
                // Send success response with combined details
                return res.status(200).json({ 
                    success: true,
                    message: 'File uploaded and data saved successfully',
                    filePath: uploadPath,
                    originalName: uploadedFile.name,
                    size: uploadedFile.size,
                    phoneNumbers: dbResult.phoneNumbers,
                    totalNumbers: dbResult.totalNumbers,
                    headers: dbResult.headers,
                    data: dbResult.data
                });
            } catch (dbError) {
                // If database save fails, delete the uploaded file
                await fs.promises.unlink(uploadPath);
                console.error('Error saving CSV data to database:', dbError);
                return res.status(400).json({ message: dbError.message || 'Failed to save CSV data to database' });
            }

        } catch (fileError) {
            console.error('Error saving file:', fileError);
            return res.status(500).json({ message: 'Failed to save file' });
        }

    } catch (error) {
        console.error('Error in uploadCSV:', error);
        return res.status(500).json({ message: 'Internal server error during CSV upload' });
    }
};

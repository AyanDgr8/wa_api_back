// src/controllers/saveNumbers.js

import connectDB from '../db/index.js';
import csv from 'csv-parser';
import { Readable } from 'stream';
import xlsx from 'xlsx';

// Function to save phone numbers to the database
export const saveCSVDataToDB = async (req) => {
    if (!req.files || !req.files.file) {
        throw new Error('No CSV file uploaded');
    }
    const instanceId = req.params.id;
    const csvFile = req.files.file;
    const results = [];
    const phoneNumbers = [];
    let headers = [];

    // Validate file type
    const fileName = csvFile.name.toLowerCase();
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
    const isCsv = fileName.endsWith('.csv');
    
    if (!isExcel && !isCsv) {
        throw new Error('Only CSV and Excel files (xlsx, xls) are allowed');
    }

    try {
        console.log('Processing CSV for instance:', instanceId);
        let dataToProcess = [];
        
        if (isExcel) {
            console.log('Processing Excel file...');
            
            // Parse Excel file with special options for number formatting
            const workbook = xlsx.read(csvFile.data, { type: 'buffer' });
            console.log('Sheets in workbook:', workbook.SheetNames);
            
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            // Force all cells to be read as strings to prevent scientific notation
            for (let cell in worksheet) {
                if (cell[0] === '!') continue; // Skip special keys
                if (worksheet[cell].t === 'n') { // If cell is number type
                    worksheet[cell].z = '@'; // Force text format
                    // Convert to string with full precision
                    worksheet[cell].v = worksheet[cell].v.toString();
                    worksheet[cell].w = worksheet[cell].v;
                }
            }
            
            // Convert Excel data to array of objects with header row
            const rows = xlsx.utils.sheet_to_json(worksheet, { 
                header: 1,
                raw: false,
                defval: ''
            });
            console.log('First few rows:', rows.slice(0, 3));
            
            if (rows.length === 0) {
                throw new Error('Excel file is empty');
            }
            
            // Extract headers
            headers = rows[0].map(h => h?.toString().trim());
            console.log('Headers found:', headers);
            
            // Find required columns
            const phoneColumnIndex = headers.findIndex(header => 
                header?.toLowerCase() === 'phone_numbers');
            const nameColumnIndex = headers.findIndex(header =>
                header?.toLowerCase() === 'name');
            
            if (phoneColumnIndex === -1 || nameColumnIndex === -1) {
                throw new Error('Required columns not found. Please ensure your Excel file has "phone_numbers" and "name" columns.');
            }
            
            console.log('Phone number column found at index:', phoneColumnIndex);
            
            // Process each row
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (row && row[phoneColumnIndex]) {
                    // Handle phone number that might be in scientific notation
                    let phone = row[phoneColumnIndex];
                    if (typeof phone === 'number') {
                        // Convert scientific notation to full number string
                        phone = phone.toLocaleString('fullwide', { useGrouping: false });
                    }
                    phone = phone.toString().trim();
                    console.log(`Processing row ${i}, phone:`, phone);
                    
                    // Clean the phone number - remove all non-digit characters
                    let cleanPhone = phone.replace(/[^\d]/g, '');
                    
                    // Validate phone number length (9-15 digits)
                    if (/^\d{9,15}$/.test(cleanPhone)) {
                        const formattedPhone = `+${cleanPhone}`;
                        phoneNumbers.push(formattedPhone);
                        
                        // Create row data with all columns
                        const rowData = {};
                        headers.forEach((header, index) => {
                            if (header) {
                                rowData[header] = row[index]?.toString().trim() || '';
                            }
                        });
                        rowData.phone_numbers = formattedPhone;
                        results.push(rowData);
                        console.log('Added valid phone number:', formattedPhone);
                    } else {
                        console.warn(`Invalid phone number format in row ${i}:`, cleanPhone);
                    }
                } else {
                    console.warn(`Missing or invalid phone number in row ${i}`);
                }
            }
        } else {
            // Process CSV file
            const csvContent = csvFile.data.toString();
            const stream = Readable.from(csvContent);

        // Parse CSV and collect all data
        await new Promise((resolve, reject) => {
            let isFirstRow = true;
            stream
                .pipe(csv())
                .on('data', (data) => {
                    console.log('Parsed row:', data);

                    // Capture headers from first row
                    if (isFirstRow) {
                        headers = Object.keys(data);
                        isFirstRow = false;
                    }

                    // Check both possible column names for phone numbers
                    const phone = data.phone_numbers || data['phone_numbers'];

                    if (phone) {
                        // Clean and format the phone number
                        const cleanPhone = phone.replace(/[\s\-\(\)]/g, '').trim();
                        
                        // Check if the number matches the expected format (with or without +)
                        if (/^\+?\d{8,15}$/.test(cleanPhone)) {
                            // Only add + if it's not already there
                            const formattedPhone = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;
                            phoneNumbers.push(formattedPhone);
                            
                            // Store all columns from the CSV
                            const rowData = { ...data };
                            rowData.phone_numbers = formattedPhone; // Use formatted phone number
                            results.push(rowData);
                            console.log('Added valid phone number:', formattedPhone);
                        } else {
                            console.warn('Invalid phone number format:', cleanPhone);
                        }
                    } else {
                        console.warn('No phone number in row. Data:', data);
                        console.warn('Available columns:', Object.keys(data));
                    }
                })
                .on('end', resolve)
                .on('error', reject);
            });
        }

        if (phoneNumbers.length === 0) {
            throw new Error('No valid phone numbers found in CSV');
        }

        console.log('Valid phone numbers:', phoneNumbers);
        console.log('CSV Headers:', headers);

        // Get database connection
        const connection = await connectDB();

        // Insert all numbers into the database
        for (const row of results) {
            try {
                await connection.query(
                    `INSERT INTO phoneList (phone_numbers, name, created_at, instance_id) 
                     VALUES (?, ?, NOW(), ?)`,
                    [row.phone_numbers, row.name, instanceId]
                );
            } catch (insertError) {
                console.error('Error inserting row:', insertError);
            }
        }

        return {
            phoneNumbers,
            totalNumbers: phoneNumbers.length,
            headers: headers,
            data: results
        };

    } catch (error) {
        console.error('Error processing CSV:', error);
        throw error;
    }
};

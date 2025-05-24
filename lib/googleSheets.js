import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

// Column headers corresponding to bot collected data
const COLUMN_HEADERS = [
  'Date',
  'Client Name',
  'Room Type',
  'Location',
  'Goal',
  'Work Done',
  'Materials',
  'Features',
  'Drive Link'
];

export async function initializeGoogleSheets() {
  try {
    // Parse service account credentials from environment variables
    const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    
    // Create JWT client for authentication
    const serviceAccountAuth = new JWT({
      email: serviceAccountKey.client_email,
      key: serviceAccountKey.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });

    // Initialize document
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    // Get first sheet or create new one if it doesn't exist
    let sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      sheet = await doc.addSheet({ title: 'Renovation Projects' });
    }
    
    // Check if column headers are set
    const rows = await sheet.getRows();
    if (rows.length === 0) {
      // If table is empty, add headers
      await sheet.setHeaderRow(COLUMN_HEADERS);
    }
    
    return sheet;
  } catch (error) {
    console.error('Error initializing Google Sheets:', error);
    throw error;
  }
}

export async function addRowToSheet(projectData) {
  try {
    const sheet = await initializeGoogleSheets();
    
    // Create new row with today's date and project data
    const newRow = {
      'Date': new Date().toLocaleDateString(),
      'Client Name': projectData.client_name,
      'Room Type': projectData.room_type,
      'Location': projectData.location,
      'Goal': projectData.goal,
      'Work Done': projectData.what_done,
      'Materials': projectData.materials,
      'Features': projectData.features,
      'Drive Link': projectData.drive_link
    };
    
    // Add row to sheet
    await sheet.addRow(newRow);
    
    return true;
  } catch (error) {
    console.error('Error adding row to sheet:', error);
    throw error;
  }
}

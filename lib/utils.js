// Function to validate Google Drive link format
export function validateDriveLink(link) {
  return link.includes('drive.google.com');
}

// Function to create admin notification text
export function createAdminNotification(data) {
  return `
📢 New Project Submitted!
👤 Client: ${data.client_name}
🏗️ Room: ${data.room_type}
📍 Location: ${data.location}
🌟 Goal: ${data.goal}
💪 Work done: ${data.what_done}
🧱 Materials: ${data.materials}
✨ Features: ${data.features}
📂 Drive: ${data.drive_link}
  `.trim();
}

// Function to check Google Drive folder structure
export function checkDriveFolderStructure(driveLink) {
  // In a real application, you could implement Google Drive API check here
  return true;
}

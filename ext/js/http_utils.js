// http_utils.js
// Handles local DB communication for querying existing marks and submitting new ones



// FIXME FIXME FIXME
// import this from config file
const BASE_URL = "http://localhost:3000/marks";





// Helper function to normalize a name for storage/searching
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
    .replace(/\s/g, '#');  // Replace spaces with #
}





// Helper function to denormalize a name for display
function denormalizeName(normalizedName) {
  if (!normalizedName) return '';
  
  // Replace # with spaces
  const nameWithSpaces = normalizedName.replace(/#/g, ' ');
  
  // Capitalize first letter of each word
  return nameWithSpaces
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}




// Save or update data in the backend
function saveData() {
  if (!STATE.name || STATE.name.trim() === '') {
    logError('Error: Name field is required to save data.');
    return; 
  }

  const data = {
    // Normalize name for storage using our standardized format
    name: normalizeName(STATE.name),
    org: STATE.org,
    title: STATE.title,
    www: STATE.www,
    location: STATE.lists.location[0],
    phone: STATE.lists.phone[0],
    email: STATE.lists.email[0],
    linkedin: STATE.linkedin,
    on_x: STATE.on_x,
    notes: STATE.notes,
    hasReplied: STATE.hasReplied,
    outreachCount: STATE.outreachCount,
    lastContact: STATE.lastContact
  };  // Server handles both create and update through POST
  
  
  // log('POSTing data to backend:', JSON.stringify(data, null, 2));
  
 
  fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify( data )
  })
  .then(response => {
    if (!response.ok) throw new Error('Network response was not ok');
    return response.json();
  })
  .then(result => {
    log('Data saved successfully.');
    // log('Data saved successfully:', result);
  })
  .catch(error => {
    log('Error saving data:', error.message);
  });
}





// Find button functionality
// 1. recover form data
// 2. look for unique fields --- normalized name, linkedin, on_x
// 3. SEARCH DB (curl http://localhost/marks?name=scott#gross)
// 4. Return matching mark (if any) and fill-in form fields
async function findData(searchParams) {
  if (!searchParams || typeof searchParams !== 'object') {
    logError('Error: Search params must be an object.');
    return null;
  }
  
  let url = new URL( BASE_URL);
  let params = new URLSearchParams();
  
  // Handle each possible search parameter
  if (searchParams.name) {
    params.append('name', normalizeName(searchParams.name));
    log('Normalized name being searched:', normalizeName(searchParams.name));
  }
  
  if (searchParams.linkedin) {
    params.append('linkedin', searchParams.linkedin);
    log('Linkedin being searched:', searchParams.linkedin);
  }
  
  if (searchParams.on_x) {
    params.append('on_x', searchParams.on_x);
    log('X handle being searched:', searchParams.on_x);
  }
  
  url.search = params.toString();
  // log('Searching with URL:', url.toString());
  
  try {
    // Make GET request to backend
    const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }    });
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const data = await response.json();
    
    if (data && data.length > 0) {
      // log('Record found:', data[0]);
      const mark = data[0];

      // Copy the contents of the mark object from the DB into the STATE object
      // Update the form fields
      sidebar_update(mark);
      

      
      return mark;
    } else {
      log('No matching records found.');
      return null;
    }
  } catch (error) {
    log('Error finding data:', error.message);
    return null;
  }
}




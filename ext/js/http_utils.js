// http_utils.js
// Handles local DB communication for querying existing marks and submitting new ones


const BASE_URL = "http://localhost:3000/marks";





// Save or update data in the backend
function saveData() {
  
  if (!STATE.name || STATE.name.trim() === '') {
    logError('Error: Name field is required to save data.');
    return; 
  }

  // set the created At to now()
  STATE.createdAt = STATE.createdAt || new Date().toISOString();

  // Create clean data object with only valid fields
  const data = STATE;

  const json_data = JSON.stringify(data, null, 2);

  log('POSTing data to backend:', json_data);


  fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: json_data
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
// 2. look for unique fields --- name, linkedin, on_x
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
    params.append('name', searchParams.name);
    log('Name being searched:', searchParams.name);
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

      // RETURN DB RECORD
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





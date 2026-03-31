/**
 * state.js
 * 
 * Manages the state of the application
 * 
 * @module state
 */
export const STATE = {
    id: null,
    name: null,
    title: null,
    org: null,
    www: null,
    email:null,
    phone:null,
    location:null,
    linkedin: null,
    on_x: null,
    outreachCount: 0,
    createdAt: null,
    lastContact: null,
    notes: null,
    hasReplied: false,
  
  };




  
  /**
   * Clear the state object
   */
  export function clearState() {
  
    // Clear the STATE
  
    STATE.id = null;
    STATE.name = null;
    STATE.title = null;
    STATE.org = null;
    STATE.www = null;
    
    STATE.email = null;
    STATE.phone = null;
    STATE.location = null;
  
    STATE.linkedin = null;
    STATE.on_x = null;
  
    STATE.outreachCount = 0;
    STATE.hasReplied = false;
    STATE.createdAt = null;
    STATE.lastContact = null;
    STATE.notes = null;
  
  
  }
  


// Copy record data into STATE
export function copyFromRecord(record) {
    STATE.id = record.id;
    STATE.name = record.name;
    STATE.org = record.org || null;
    STATE.title = record.title || null;
    STATE.www = record.www || null;
    STATE.outreachCount = record.outreachCount || 0;
    STATE.lastContact = record.lastContact || null;
    STATE.notes = record.notes || null;
    STATE.linkedin = record.linkedin || null;
    STATE.on_x = record.on_x || null;
    STATE.hasReplied = record.hasReplied || false;

    STATE.location = record.location || null;
    STATE.phone = record.phone || null;
    STATE.email = record.email || null;
  
}
  
  
  //
  // Merge data: Only update fields that are empty in the current STATE
  //
  export function mergePageData(parsedData) {
        
    if (!STATE.name && parsedData.name) STATE.name = parsedData.name;
    if (!STATE.org && parsedData.org) STATE.org = parsedData.org;
    if (!STATE.title && parsedData.title) STATE.title = parsedData.title;
    if (!STATE.linkedin && parsedData.linkedin) STATE.linkedin = parsedData.linkedin;
    if (!STATE.on_x && parsedData.on_x) STATE.on_x = parsedData.on_x; 
    if (!STATE.www && parsedData.www) STATE.www = parsedData.www;

    if (!STATE.email && parsedData.email) STATE.email = parsedData.email;
    if (!STATE.phone && parsedData.phone) STATE.phone = parsedData.phone;
    if (!STATE.location && parsedData.location) STATE.location = parsedData.location;

    if (!STATE.linkedin && parsedData.linkedin) STATE.linkedin = parsedData.linkedin;
  }
  
  
  
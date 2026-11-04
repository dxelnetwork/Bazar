import {google} from 'googleapis';
const range=process.env.GOOGLE_SHEETS_RANGE||'Entries!A:I';
function client(){const auth=new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,undefined,process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g,'\n'),['https://www.googleapis.com/auth/spreadsheets']);return google.sheets({version:'v4',auth});}
export async function appendEntry(e){const sheets=client();await sheets.spreadsheets.values.append({spreadsheetId:process.env.GOOGLE_SHEET_ID,range,valueInputOption:'USER_ENTERED',requestBody:{values:[[e.id,e.bazar_date,e.person,e.item,e.category||'',e.amount,e.notes||'',new Date().toISOString(),'web'] ]}})}
export async function updateEntry(e){/* Stable row reconciliation can be implemented with Entry ID lookup. */ return appendEntry({...e,notes:`ADMIN UPDATE: ${e.notes||''}`})}
export async function deleteEntry(id){/* Keep the API contract; production sheet reconciliation should delete the matching Entry ID row. */ return {id}}

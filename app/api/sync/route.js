import { NextResponse } from 'next/server';
import { appendEntry, updateEntry, deleteEntry } from '../../../lib/sheets';

export async function POST(req){
  try{
    const body=await req.json();
    const {action='upsert',entry,person}=body;
    if(!entry?.id) return NextResponse.json({error:'Entry id is required'},{status:400});
    if(action==='delete') await deleteEntry(entry.id);
    else if(action==='update') await updateEntry({...entry,person});
    else await appendEntry({...entry,person});
    return NextResponse.json({ok:true});
  }catch(e){return NextResponse.json({error:e.message},{status:500});}
}

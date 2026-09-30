import React, {useEffect, useMemo, useState} from 'react';
import {MapPin, ChevronDown, Search, X, LockKeyhole} from 'lucide-react';
import {MARKET_LOCATIONS, getSelectedCity, setSelectedCity} from './location.js';

export default function LocationPicker({lockedCity=null}){
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState('');
  const [selected,setSelected]=useState(()=>lockedCity||getSelectedCity());

  useEffect(()=>{ if(lockedCity) setSelected(lockedCity); },[lockedCity]);
  useEffect(()=>{
    const sync=e=>{ if(!lockedCity) setSelected(e?.detail?.city||getSelectedCity()); };
    window.addEventListener('meetmart:city-changed',sync);
    return()=>window.removeEventListener('meetmart:city-changed',sync);
  },[lockedCity]);

  const filtered=useMemo(()=>{
    const q=query.trim().toLowerCase();
    if(!q)return MARKET_LOCATIONS;
    return MARKET_LOCATIONS.filter(x=>`${x.state} ${x.city}`.toLowerCase().includes(q));
  },[query]);

  const choose=city=>{
    if(lockedCity)return;
    const next=setSelectedCity(city);
    setSelected(next);
    setOpen(false);
    setQuery('');
    window.location.reload();
  };

  const selectedLocation=MARKET_LOCATIONS.find(x=>x.city===selected);
  return <div className="location-picker">
    <button className="city-chip location-trigger" type="button" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>
      <MapPin size={16}/><span>{selected}</span>{lockedCity?<LockKeyhole size={13}/>:<ChevronDown size={15}/>} 
    </button>
    {open&&<div className="location-popover" role="dialog" aria-label="Choose marketplace location">
      <div className="location-popover-head"><div><b>{lockedCity?'Your account city':'Choose your location'}</b><small>{lockedCity?'Marketplace accounts stay in one city for safer local trading.':'Browse marketplace listings in another Nigerian city.'}</small></div><button type="button" onClick={()=>setOpen(false)} aria-label="Close"><X size={18}/></button></div>
      {lockedCity?<div className="location-locked"><MapPin size={20}/><div><b>{lockedCity}</b><small>{selectedLocation?.state||'Nigeria'} • Change of account city will be added through profile verification.</small></div></div>:<>
        <label className="location-search"><Search size={16}/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search state or city..."/></label>
        <div className="location-list">{filtered.map(x=><button type="button" key={`${x.state}-${x.city}`} className={selected===x.city?'active':''} onClick={()=>choose(x.city)}><span><b>{x.city}</b><small>{x.state}</small></span>{selected===x.city&&<span>✓</span>}</button>)}</div>
      </>}
    </div>}
  </div>;
}

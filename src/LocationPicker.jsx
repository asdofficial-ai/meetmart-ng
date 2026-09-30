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
  useEffect(()=>{
    if(!open)return;
    const onKey=e=>{if(e.key==='Escape')setOpen(false)};
    window.addEventListener('keydown',onKey);
    return()=>window.removeEventListener('keydown',onKey);
  },[open]);

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
  return <div className={`location-picker ${open?'is-open':''}`}>
    <button className="city-chip location-trigger" type="button" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>
      <MapPin size={16}/><span>{selected}</span>{lockedCity?<LockKeyhole size={13}/>:<ChevronDown size={15}/>} 
    </button>
    {open&&<>
      <button className="location-backdrop" type="button" aria-label="Close location picker" onClick={()=>setOpen(false)}/>
      <div className="location-popover" role="dialog" aria-modal="true" aria-label="Choose marketplace location">
        <div className="location-popover-head"><div><span className="location-kicker">MARKETPLACE LOCATION</span><b>{lockedCity?'Your account city':'Choose your location'}</b><small>{lockedCity?'Your city is locked after signup to keep person-to-person trading local.':'Choose the Nigerian city where you want to browse and trade.'}</small></div><button type="button" onClick={()=>setOpen(false)} aria-label="Close"><X size={20}/></button></div>
        {lockedCity?<div className="location-locked"><span className="location-lock-icon"><LockKeyhole size={20}/></span><div><b>{lockedCity}</b><small>{selectedLocation?.state||'Nigeria'} • Account city changes require a future verified profile-change flow.</small></div></div>:<>
          <label className="location-search"><Search size={18}/><input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search state or city..."/></label>
          <div className="location-list-meta"><b>{query?`${filtered.length} match${filtered.length===1?'':'es'}`:'Nigeria marketplace cities'}</b><small>Tap a city to switch your local marketplace</small></div>
          <div className="location-list">{filtered.map(x=><button type="button" key={`${x.state}-${x.city}`} className={selected===x.city?'active':''} onClick={()=>choose(x.city)}><span><b>{x.city}</b><small>{x.state}</small></span><span className="location-check">{selected===x.city?'✓':'›'}</span></button>)}</div>
          {!filtered.length&&<div className="location-empty"><MapPin/><b>No matching city</b><small>Try searching by state name or another city.</small></div>}
        </>}
      </div>
    </>}
  </div>;
}

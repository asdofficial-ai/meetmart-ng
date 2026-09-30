export const MARKET_LOCATIONS = [
  {state:'Abia', city:'Umuahia'},
  {state:'Adamawa', city:'Yola'},
  {state:'Akwa Ibom', city:'Uyo'},
  {state:'Anambra', city:'Awka'},
  {state:'Bauchi', city:'Bauchi'},
  {state:'Bayelsa', city:'Yenagoa'},
  {state:'Benue', city:'Makurdi'},
  {state:'Borno', city:'Maiduguri'},
  {state:'Cross River', city:'Calabar'},
  {state:'Delta', city:'Asaba'},
  {state:'Ebonyi', city:'Abakaliki'},
  {state:'Edo', city:'Benin City'},
  {state:'Ekiti', city:'Ado Ekiti'},
  {state:'Enugu', city:'Enugu'},
  {state:'Gombe', city:'Gombe'},
  {state:'Imo', city:'Owerri'},
  {state:'Jigawa', city:'Dutse'},
  {state:'Kaduna', city:'Kaduna'},
  {state:'Kano', city:'Kano'},
  {state:'Katsina', city:'Katsina'},
  {state:'Kebbi', city:'Birnin Kebbi'},
  {state:'Kogi', city:'Lokoja'},
  {state:'Kwara', city:'Ilorin'},
  {state:'Lagos', city:'Lagos'},
  {state:'Nasarawa', city:'Lafia'},
  {state:'Niger', city:'Minna'},
  {state:'Ogun', city:'Abeokuta'},
  {state:'Ondo', city:'Akure'},
  {state:'Osun', city:'Osogbo'},
  {state:'Oyo', city:'Ibadan'},
  {state:'Plateau', city:'Jos'},
  {state:'Rivers', city:'Port Harcourt'},
  {state:'Sokoto', city:'Sokoto'},
  {state:'Taraba', city:'Jalingo'},
  {state:'Yobe', city:'Damaturu'},
  {state:'Zamfara', city:'Gusau'},
  {state:'FCT', city:'Abuja'},
];

const CITY_SET = new Set(MARKET_LOCATIONS.map(x=>x.city));
const STORAGE_KEY = 'meetmart-city';

export function isSupportedCity(city){ return CITY_SET.has(String(city||'').trim()); }
export function getSelectedCity(){
  try{
    const stored=window.localStorage.getItem(STORAGE_KEY);
    return isSupportedCity(stored)?stored:'Kaduna';
  }catch{return 'Kaduna';}
}
export function setSelectedCity(city){
  const next=isSupportedCity(city)?city:'Kaduna';
  try{window.localStorage.setItem(STORAGE_KEY,next);}catch{}
  try{window.dispatchEvent(new CustomEvent('meetmart:city-changed',{detail:{city:next}}));}catch{}
  return next;
}
export function getLocationForCity(city){ return MARKET_LOCATIONS.find(x=>x.city===city)||MARKET_LOCATIONS.find(x=>x.city==='Kaduna'); }

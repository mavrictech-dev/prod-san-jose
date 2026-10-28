/** Revoke from any workspace page, including after a reload where no panel CSRF
 * exists in memory. The server requires same-origin metadata and this intent. */
export function clearAdminSessionFromWorkspace(){
 if(typeof window==='undefined')return;
 try{window.dispatchEvent(new Event('factuez:workspace-logout'));}catch{/* Local cleanup must not prevent the workspace logout. */}
 if(window.location.protocol!=='https:')return;
 try{void fetch('/bff/b2b-admin/session/logout',{method:'POST',body:'{}',cache:'no-store',credentials:'same-origin',redirect:'error',keepalive:true,
  headers:{Accept:'application/json','Content-Type':'application/json','X-FactuEz-Logout':'workspace'}}).then(response=>response.body?.cancel()).catch(()=>{});}catch{/* Server expiry remains the bound when the connection is unavailable. */}
}

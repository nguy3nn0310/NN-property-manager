/*
RENAME THIS FILE:
app.txt  ->  app.js

NN Rental Manager — Supabase production starter
*/
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}).format(Number(n)||0);
const cfg = window.NN_CONFIG || {};
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR_PROJECT') &&
                   cfg.SUPABASE_PUBLISHABLE_KEY && !cfg.SUPABASE_PUBLISHABLE_KEY.includes('YOUR_SUPABASE');

let sb = null;
let sessionUser = null;
let role = null;
let tenantLease = null;

if (configured) {
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  $('#setupNotice').innerHTML = 'Supabase connected. Sign in with an account created in Supabase Auth.';
} else {
  $('#setupNotice').innerHTML = '<b>Setup required:</b> rename <code>config.txt</code> to <code>config.js</code> and add your Supabase URL + publishable key.';
}

function initTabs(container){
  if (!container) return;
  container.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    container.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const section = container.closest('section');
    section.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $('#'+b.dataset.target).classList.add('active');
  });
}
initTabs($('#tenantTabs'));
initTabs($('#ownerTabs'));

$$('.role').forEach(b => b.onclick = () => {
  $$('.role').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
});

function setSignedOut(){
  sessionUser = null; role = null; tenantLease = null;
  $('#loginView').classList.remove('hidden');
  $('#tenantView').classList.add('hidden');
  $('#ownerView').classList.add('hidden');
  $('#logoutBtn').classList.add('hidden');
  $('#sessionLabel').textContent = 'Signed out';
}
function setSignedIn(label){
  $('#loginView').classList.add('hidden');
  $('#logoutBtn').classList.remove('hidden');
  $('#sessionLabel').textContent = label;
}

async function getRole(userId){
  const { data: ownerRow } = await sb.from('owners').select('user_id').eq('user_id', userId).maybeSingle();
  if (ownerRow) return 'owner';

  const { data: lease } = await sb.from('leases')
    .select('id,unit_id,tenant_id,status,units(*)')
    .eq('tenant_id', userId)
    .eq('status', 'active')
    .maybeSingle();

  if (lease) {
    tenantLease = lease;
    return 'tenant';
  }
  return null;
}

async function routeUser(){
  if (!configured) { setSignedOut(); return; }
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { setSignedOut(); return; }

  sessionUser = user;
  role = await getRole(user.id);

  if (role === 'owner'){
    setSignedIn('Owner signed in');
    $('#ownerView').classList.remove('hidden');
    $('#tenantView').classList.add('hidden');
    await renderOwner();
  } else if (role === 'tenant'){
    setSignedIn('Tenant signed in');
    $('#tenantView').classList.remove('hidden');
    $('#ownerView').classList.add('hidden');
    await renderTenant();
  } else {
    alert('This login exists, but it is not assigned as an owner or active tenant yet.');
    await sb.auth.signOut();
    setSignedOut();
  }
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  if (!configured) {
    alert('Add your Supabase URL and publishable key to config.js first.');
    return;
  }
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  const wantedRole = $('.role.active').dataset.role;

  const { data, error } = await sb.auth.signInWithPassword({email, password});
  if (error) { alert(error.message); return; }

  sessionUser = data.user;
  role = await getRole(data.user.id);

  if (role !== wantedRole){
    await sb.auth.signOut();
    alert(`This account is not assigned as ${wantedRole}.`);
    setSignedOut();
    return;
  }
  await routeUser();
};

$('#logoutBtn').onclick = async () => {
  if (sb) await sb.auth.signOut();
  setSignedOut();
};

async function renderTenant(){
  const lease = tenantLease;
  if (!lease) return;
  const u = lease.units;

  const { data: profile } = await sb.from('profiles').select('full_name').eq('id', sessionUser.id).maybeSingle();
  $('#tenantGreeting').textContent = `Welcome, ${profile?.full_name || sessionUser.email}`;
  $('#tenantAddress').textContent = `${u.name} • ${u.address}`;
  $('#tenantRent').textContent = money(u.rent_amount);
  $('#tenantBalance').textContent = money(u.balance);
  $('#tenantDeposit').textContent = money(u.deposit_held);
  $('#rentAmount').value = Number(u.balance) > 0 ? u.balance : u.rent_amount;

  const { data: ledger = [] } = await sb.from('ledger_entries')
    .select('*').eq('tenant_id', sessionUser.id).order('created_at', {ascending:false}).limit(20);

  $('#tenantLedger').innerHTML = ledger.length ? ledger.map(x => `
    <p><b>${new Date(x.created_at).toLocaleDateString()}</b><br>
    ${x.entry_type} — <span class="money">${money(x.amount)}</span>${x.note ? ` • ${x.note}` : ''}</p>
  `).join('') : '<div class="empty">No ledger activity yet.</div>';

  const { data: requests = [] } = await sb.from('maintenance_requests')
    .select('*,work_orders(*)').eq('tenant_id', sessionUser.id)
    .order('created_at', {ascending:false});

  $('#tenantRequests').innerHTML = requests.length ? requests.map(r => `
    <p><b>#${r.id} ${r.category}</b><br>${r.description}<br>
    <span class="status ${r.status === 'Completed' ? '' : 'warn'}">${r.status}</span></p>
  `).join('') : '<div class="empty">No maintenance requests.</div>';

  await renderTenantMessages();
}

$('#rentForm').onsubmit = async e => {
  e.preventDefault();
  if (!cfg.PAYMENTS_ENABLED){
    $('#rentNotice').textContent = 'Stripe is not enabled yet. Finish the Stripe Edge Function setup, then set PAYMENTS_ENABLED to true in config.js.';
    return;
  }
  const amount = Number($('#rentAmount').value);
  if (!amount || amount <= 0) return;

  $('#rentNotice').textContent = 'Opening secure payment page...';
  const { data, error } = await sb.functions.invoke('create-rent-checkout', {
    body: {
      amount,
      successUrl: location.origin + location.pathname + '?payment=success',
      cancelUrl: location.origin + location.pathname + '?payment=cancelled'
    }
  });
  if (error || !data?.url){
    $('#rentNotice').textContent = error?.message || 'Could not start payment.';
    return;
  }
  location.href = data.url;
};

$('#repairForm').onsubmit = async e => {
  e.preventDefault();
  const payload = {
    tenant_id: sessionUser.id,
    unit_id: tenantLease.unit_id,
    category: $('#repairCategory').value,
    priority: $('#repairPriority').value,
    description: $('#repairDescription').value.trim(),
    photo_url: $('#repairPhoto').value.trim() || null,
    status: 'New'
  };
  const { error } = await sb.from('maintenance_requests').insert(payload);
  if (error) { alert(error.message); return; }
  e.target.reset();
  await renderTenant();
  alert('Maintenance request sent.');
};

async function renderTenantMessages(){
  const { data: list = [] } = await sb.from('messages').select('*')
    .eq('tenant_id', sessionUser.id).order('created_at', {ascending:true});

  $('#tenantMessages').innerHTML = list.length ? list.map(m => `
    <div class="msg ${m.sender_user_id === sessionUser.id ? 'me' : ''}">
      ${escapeHtml(m.body)}
      <small>${m.sender_user_id === sessionUser.id ? 'You' : 'Owner'} • ${new Date(m.created_at).toLocaleString()}</small>
    </div>
  `).join('') : '<div class="empty">No messages yet.</div>';
}

$('#tenantMessageForm').onsubmit = async e => {
  e.preventDefault();
  const body = $('#tenantMessageText').value.trim();
  if (!body) return;
  const { error } = await sb.from('messages').insert({
    tenant_id: sessionUser.id,
    sender_user_id: sessionUser.id,
    body
  });
  if (error) { alert(error.message); return; }
  $('#tenantMessageText').value = '';
  await renderTenantMessages();
};

async function renderOwner(){
  const [{data:units=[]},{data:profiles=[]},{data:leases=[]},{data:requests=[]}] = await Promise.all([
    sb.from('units').select('*').order('id'),
    sb.from('profiles').select('id,full_name,email,phone'),
    sb.from('leases').select('*').eq('status','active'),
    sb.from('maintenance_requests').select('*,work_orders(*)').order('created_at',{ascending:false})
  ]);

  const profileMap = Object.fromEntries(profiles.map(p => [p.id,p]));
  const leaseByUnit = Object.fromEntries(leases.map(l => [l.unit_id,l]));
  const occupied = leases.length;

  $('#ownerOccupied').textContent = `${occupied}/10`;
  $('#ownerDue').textContent = money(units.reduce((s,u) => s + Number(u.balance||0),0));
  $('#ownerDeposits').textContent = money(units.reduce((s,u) => s + Number(u.deposit_held||0),0));
  $('#ownerRepairs').textContent = requests.filter(r => r.status !== 'Completed').length;

  $('#propertyGrid').innerHTML = units.map(u => {
    const l = leaseByUnit[u.id], p = l ? profileMap[l.tenant_id] : null;
    return `<div class="card property-card">
      <p class="eyebrow">Unit ${String(u.id).padStart(2,'0')}</p>
      <h3>${escapeHtml(u.name)}</h3><p>${escapeHtml(u.address)}</p>
      <span class="status ${p ? '' : 'neutral'}">${p ? 'Occupied' : 'Vacant'}</span>
      <p>Tenant: <b>${p ? escapeHtml(p.full_name || p.email || '') : '—'}</b></p>
      <p>Rent: <span class="money">${money(u.rent_amount)}</span></p>
      <p>Balance: <span class="money">${money(u.balance)}</span></p>
      <p>Deposit: <span class="money">${money(u.deposit_held)}</span></p>
    </div>`;
  }).join('');

  renderWorkOrders(requests, units);
  await renderApplications(units);
  renderLedger(units, leases, profileMap);
  await renderOwnerMessages(profileMap);
}

function renderWorkOrders(requests, units){
  const unitMap = Object.fromEntries(units.map(u => [u.id,u]));
  $('#workOrderBody').innerHTML = requests.length ? requests.map(r => {
    const wo = Array.isArray(r.work_orders) ? r.work_orders[0] : r.work_orders;
    return `<tr>
      <td>#${r.id}</td><td>${escapeHtml(unitMap[r.unit_id]?.name || '')}</td>
      <td><b>${escapeHtml(r.category)}</b><br>${escapeHtml(r.description)}</td>
      <td>${escapeHtml(r.priority)}</td>
      <td><span class="status ${r.status === 'Completed' ? '' : 'warn'}">${escapeHtml(r.status)}</span></td>
      <td>${money(wo?.vendor_cost||0)}</td><td>${money(wo?.tenant_charge||0)}</td>
      <td><div class="row-actions">
        <button onclick="advanceRepair(${r.id},'${r.status}')">${r.status === 'New' ? 'Start' : r.status === 'In Progress' ? 'Complete' : 'Done'}</button>
        <button onclick="setCosts(${r.id},${Number(wo?.vendor_cost||0)},${Number(wo?.tenant_charge||0)})">Costs</button>
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="8">No work orders.</td></tr>';
}

window.advanceRepair = async (id,status) => {
  const next = status === 'New' ? 'In Progress' : status === 'In Progress' ? 'Completed' : 'Completed';
  const { error } = await sb.rpc('owner_update_work_order', {
    p_request_id:id, p_status:next, p_vendor_cost:null, p_tenant_charge:null
  });
  if (error) alert(error.message);
  await renderOwner();
};

window.setCosts = async (id,vendorOld,chargeOld) => {
  const v = prompt('Vendor / repair cost:', vendorOld);
  if (v === null) return;
  const c = prompt('Amount charged to tenant:', chargeOld);
  if (c === null) return;
  const { error } = await sb.rpc('owner_update_work_order', {
    p_request_id:id,
    p_status:null,
    p_vendor_cost:Math.max(0,Number(v)||0),
    p_tenant_charge:Math.max(0,Number(c)||0)
  });
  if (error) alert(error.message);
  await renderOwner();
};

async function renderApplications(units){
  const unitMap = Object.fromEntries(units.map(u => [u.id,u]));
  const { data: apps = [] } = await sb.from('rental_applications').select('*').order('created_at',{ascending:false});
  $('#applicationBody').innerHTML = apps.length ? apps.map(a => `<tr>
    <td>${escapeHtml(a.full_name)}<br><small>${escapeHtml(a.email)} • ${escapeHtml(a.phone||'')}</small></td>
    <td>${escapeHtml(unitMap[a.unit_id]?.name||'')}</td><td>${money(a.monthly_income)}</td>
    <td>${a.move_in_date||'—'}</td><td><span class="status ${a.status==='Pending'?'warn':''}">${escapeHtml(a.status)}</span></td>
    <td><div class="row-actions">
      <button onclick="setAppStatus(${a.id},'Approved')">Approve</button>
      <button onclick="setAppStatus(${a.id},'Denied')">Deny</button>
    </div></td>
  </tr>`).join('') : '<tr><td colspan="6">No applications.</td></tr>';
}

window.setAppStatus = async (id,status) => {
  const { error } = await sb.from('rental_applications').update({status}).eq('id',id);
  if (error) alert(error.message);
  await renderOwner();
};

function renderLedger(units, leases, profileMap){
  const leaseByUnit = Object.fromEntries(leases.map(l => [l.unit_id,l]));
  $('#ledgerBody').innerHTML = units.map(u => {
    const l=leaseByUnit[u.id], p=l?profileMap[l.tenant_id]:null;
    return `<tr><td>${escapeHtml(u.name)}</td><td>${p?escapeHtml(p.full_name||p.email||''):'Vacant'}</td>
    <td>${money(u.rent_amount)}</td><td class="money">${money(u.balance)}</td>
    <td class="money">${money(u.deposit_held)}</td>
    <td>${!p?'—':Number(u.balance)>0?'<span class="status warn">Balance Due</span>':'<span class="status">Current</span>'}</td></tr>`;
  }).join('');
}

async function renderOwnerMessages(profileMap){
  const { data:list=[] } = await sb.from('messages').select('*').order('created_at',{ascending:true});
  const ids = [...new Set(list.map(m => m.tenant_id))];
  $('#ownerMessageThreads').innerHTML = ids.length ? ids.map(id => {
    const p=profileMap[id], thread=list.filter(m=>m.tenant_id===id);
    return `<div class="thread"><h3>${escapeHtml(p?.full_name||p?.email||'Tenant')}</h3>
      ${thread.map(m=>`<div class="msg ${m.sender_user_id===sessionUser.id?'me':''}">
        ${escapeHtml(m.body)}
        <small>${m.sender_user_id===sessionUser.id?'Owner':'Tenant'} • ${new Date(m.created_at).toLocaleString()}</small>
      </div>`).join('')}
      <form onsubmit="replyTenant(event,'${id}')" class="message-form">
        <input name="reply" placeholder="Reply..." required><button>Send</button>
      </form></div>`;
  }).join('') : '<div class="empty">No tenant messages.</div>';
}
window.replyTenant = async (e,id) => {
  e.preventDefault();
  const input=e.target.elements.reply, body=input.value.trim();
  if(!body) return;
  const {error}=await sb.from('messages').insert({tenant_id:id,sender_user_id:sessionUser.id,body});
  if(error) alert(error.message);
  input.value='';
  await renderOwner();
};

async function loadPublicUnits(){
  if (!configured) {
    $('#appUnit').innerHTML = '<option>Configure Supabase first</option>';
    return;
  }
  const {data:units=[]}=await sb.from('public_units').select('*').order('id');
  $('#appUnit').innerHTML = units.map(u => `<option value="${u.id}">${escapeHtml(u.name)} — ${escapeHtml(u.address)}${u.is_vacant?' (Vacant)':' (Occupied)'}</option>`).join('');
}

$('#applicationForm').onsubmit = async e => {
  e.preventDefault();
  if(!configured){ alert('Configure Supabase first.'); return; }
  const {error}=await sb.from('rental_applications').insert({
    full_name:$('#appName').value.trim(),
    email:$('#appEmail').value.trim(),
    phone:$('#appPhone').value.trim(),
    unit_id:Number($('#appUnit').value),
    monthly_income:Number($('#appIncome').value)||0,
    move_in_date:$('#appMoveDate').value||null,
    message:$('#appMessage').value.trim()||null
  });
  if(error){ alert(error.message); return; }
  e.target.reset();
  $('#appResult').innerHTML='<div class="notice">Application submitted successfully.</div>';
  await loadPublicUnits();
};

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

(async function boot(){
  await loadPublicUnits();
  if (!configured) return setSignedOut();

  const params = new URLSearchParams(location.search);
  if (params.get('payment') === 'success') $('#rentNotice').textContent = 'Payment submitted. Bank payments can take time to settle; the balance updates after Stripe confirms payment.';
  if (params.get('payment') === 'cancelled') $('#rentNotice').textContent = 'Payment cancelled. No payment was recorded.';

  sb.auth.onAuthStateChange(() => setTimeout(routeUser,0));
  await routeUser();
})();

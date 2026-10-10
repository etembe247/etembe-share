(() => {
'use strict';
const $ = id => document.getElementById(id);
const CHUNK = 64 * 1024, HIGH_WATER = 1024 * 1024, LOW_WATER = 256 * 1024;
const MAX_INCOMING_BYTES = 512 * 1024 * 1024; // Memory-based fallback safety limit.
let messageQueue = Promise.resolve(), activeBatch = false, expectedTotalBytes = 0, receivedTotalBytes = 0;
let mode = 'files', pc = null, channel = null, role = null, selectedFiles = [];
let transferToken = 0, transferBusy = false, remoteAbort = false;
let incoming = null, incomingParts = [], incomingBytes = 0, expectedFiles = 0, completedFiles = 0;
const receivedUrls = new Set();

function setStatus(message, kind='') { $('status').textContent = message; $('status').className = 'status' + (kind ? ' ' + kind : ''); }
function progress(done, total, label) {
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  $('progress-bar').style.width = pct + '%'; $('progress-pct').textContent = total > 0 ? pct + '%' : '0%'; $('progress-label').textContent = label;
}
function safeParse(value) {
  if (typeof value !== 'string' || value.length > 2_000_000) throw new Error('Pairing text is empty or too large.');
  let parsed; try { parsed = JSON.parse(value); } catch { throw new Error('Pairing text is not valid JSON. Copy the entire offer/answer without editing it.'); }
  if (!parsed || !['offer','answer'].includes(parsed.type) || !parsed.sdp || typeof parsed.sdp !== 'string') throw new Error('Pairing text does not contain a valid WebRTC offer or answer.');
  return parsed;
}
function waitForIce(pcRef, timeoutMs=20000) {
  return new Promise((resolve, reject) => {
    if (pcRef.iceGatheringState === 'complete') return resolve();
    let settled = false;
    const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); pcRef.removeEventListener('icegatheringstatechange', check); err ? reject(err) : resolve(); };
    const check = () => { if (pcRef.iceGatheringState === 'complete') finish(); };
    const timer = setTimeout(() => finish(new Error('ICE candidate gathering timed out. You may still try the generated description, but connection may fail.')), timeoutMs);
    pcRef.addEventListener('icegatheringstatechange', check);
  });
}
function createPeer() {
  closePeer(false);
  if (!window.isSecureContext) throw new Error('For security, open this app over HTTPS (localhost is allowed for development).');
  if (!('RTCPeerConnection' in window)) throw new Error('This browser does not support WebRTC. Use an up-to-date browser over HTTPS.');
  pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}]});
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') setStatus('Encrypted peer connection established. Recipient identity is not independently verified.', 'good');
    else if (pc.connectionState === 'failed') setStatus('Connection failed. Try another network; some networks require a TURN relay.', 'bad');
    else if (pc.connectionState === 'disconnected') setStatus('Peer disconnected. Waiting for recovery…', 'warn');
    else if (pc.connectionState === 'closed') setStatus('Connection closed.');
  };
  pc.oniceconnectionstatechange = () => {
    if (pc && pc.iceConnectionState === 'failed') setStatus('ICE route failed. This static app has no TURN relay; try a different network.', 'bad');
  };
  pc.ondatachannel = event => attachChannel(event.channel);
  return pc;
}
function attachChannel(ch) {
  channel = ch; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = LOW_WATER;
  channel.onopen = () => { $('send-btn').disabled = false; setStatus('Peer connected. Select files or text, then press Send selected content.', 'good'); };
  channel.onclose = () => { $('send-btn').disabled = true; setStatus('Data channel closed.', 'warn'); };
  channel.onerror = () => setStatus('Data channel error. Try reconnecting.', 'bad');
  channel.onmessage = handleMessage;
}
function closePeer(show=true) {
  transferToken++; remoteAbort = false;
  activeBatch = false; incoming = null; incomingParts = []; incomingBytes = 0; messageQueue = Promise.resolve();
  if (channel) { try { channel.close(); } catch {} }
  if (pc) { try { pc.close(); } catch {} }
  channel = null; pc = null; role = null; transferBusy = false; $('send-btn').disabled = true;
  if (show) { setStatus('Connection closed.'); progress(0,0,'No transfer in progress'); }
}
function setMode(next) {
  mode = next; $('tab-files').classList.toggle('active', next === 'files'); $('tab-text').classList.toggle('active', next === 'text');
  $('files-view').classList.toggle('hidden', next !== 'files'); $('text-view').classList.toggle('hidden', next !== 'text');
}
function renderFiles() {
  const list = $('file-list'); list.replaceChildren();
  selectedFiles.forEach((file, index) => {
    const row = document.createElement('div'); row.className = 'file';
    const name = document.createElement('span'); name.className = 'fname'; name.textContent = file.name;
    const size = document.createElement('span'); size.className = 'size'; size.textContent = `${(file.size/1048576).toFixed(2)} MB`;
    const remove = document.createElement('button'); remove.className = 'btn inlinebtn'; remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => { selectedFiles.splice(index,1); renderFiles(); });
    row.append(name,size,remove); list.append(row);
  });
}
function offerString(desc) { return JSON.stringify({type:desc.type,sdp:desc.sdp}); }
async function makeOffer() {
  const p = createPeer(); role = 'sender';
  attachChannel(p.createDataChannel('etembe-transfer',{ordered:true}));
  setStatus('Creating offer and gathering network candidates…');
  await p.setLocalDescription(await p.createOffer());
  try { await waitForIce(p); } catch (e) { setStatus(e.message,'warn'); }
  if (!p.localDescription) throw new Error('The browser did not create a local description.');
  $('offer-out').value = offerString(p.localDescription);
  $('copy-offer').disabled = false; $('download-offer').disabled = false;
  setStatus('Offer ready. Send the complete offer text to the receiver, then wait for their answer.', 'good');
}
async function makeAnswer() {
  const desc = safeParse($('offer-in').value.trim());
  if (desc.type !== 'offer') throw new Error('Paste an offer (not an answer) into the receiver offer field.');
  const p = createPeer(); role = 'receiver';
  await p.setRemoteDescription(desc);
  await p.setLocalDescription(await p.createAnswer());
  try { await waitForIce(p); } catch (e) { setStatus(e.message,'warn'); }
  if (!p.localDescription) throw new Error('The browser did not create a local answer.');
  $('answer-out').value = offerString(p.localDescription);
  $('copy-answer').disabled = false; $('download-answer').disabled = false;
  setStatus('Answer ready. Send the complete answer text back to the sender.', 'good');
}
async function applyAnswer() {
  if (!pc || role !== 'sender') throw new Error('Create a sender offer on this device first.');
  const desc = safeParse($('answer-in').value.trim());
  if (desc.type !== 'answer') throw new Error('Paste an answer (not an offer) into the sender answer field.');
  await pc.setRemoteDescription(desc);
  setStatus('Answer applied. Waiting for the peer connection…', 'warn');
}
function sendJson(obj) {
  if (!channel || channel.readyState !== 'open') throw new Error('No peer connection is open.');
  channel.send(JSON.stringify(obj));
}
function waitForDrain(ch, token) {
  return new Promise((resolve,reject) => {
    if (token !== transferToken) return reject(new Error('Transfer cancelled.'));
    if (ch.bufferedAmount <= HIGH_WATER) return resolve();
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Sending stalled because the peer stopped accepting data.')); }, 30000);
    const cleanup = () => { clearTimeout(timeout); ch.removeEventListener('bufferedamountlow', onLow); };
    const onLow = () => { cleanup(); token === transferToken ? resolve() : reject(new Error('Transfer cancelled.')); };
    ch.addEventListener('bufferedamountlow', onLow, {once:true});
  });
}
async function sendPayload() {
  if (!channel || channel.readyState !== 'open') throw new Error('Connect both devices before sending.');
  if (transferBusy) throw new Error('A transfer is already in progress.');
  if (mode === 'text') {
    const text = $('text-input').value;
    if (!text.trim()) throw new Error('Enter text or a link before sending.');
    if (text.length > 60000) throw new Error('Text is too large for a single message. Keep it under 60,000 characters or send it as a text file.');
    sendJson({kind:'text', text});
    setStatus('Text sent successfully over the peer connection.', 'good');
    return;
  }
  const files = selectedFiles.slice();
  if (!files.length) throw new Error('Choose at least one file before sending.');
  if (!window.crypto || !crypto.subtle) throw new Error('This browser cannot perform the required SHA-256 integrity checks. Open the app over HTTPS in a current browser.');
  const totalBytes = files.reduce((sum,f)=>sum+f.size,0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_INCOMING_BYTES) throw new Error('This release supports file batches up to 512 MiB because received files are buffered in memory.');
  transferBusy = true; remoteAbort = false; $('send-btn').disabled = true;
  const token = ++transferToken;
  try {
    sendJson({kind:'batch-start',count:files.length,totalBytes});
    let sentBytes = 0;
    for (let i=0;i<files.length;i++) {
      if (token !== transferToken || remoteAbort) throw new Error(remoteAbort ? 'The receiver rejected or cancelled the transfer.' : 'Transfer cancelled.');
      const file=files[i], id=`${Date.now()}-${i}-${Math.random().toString(36).slice(2,8)}`;
      sendJson({kind:'file-start',id,name:file.name,size:file.size,mime:file.type||'application/octet-stream',lastModified:file.lastModified});
      let offset=0;
      while(offset<file.size) {
        if(token!==transferToken || remoteAbort) throw new Error(remoteAbort ? 'The receiver rejected or cancelled the transfer.' : 'Transfer cancelled.');
        await waitForDrain(channel,token);
        const chunk=await file.slice(offset,Math.min(offset+CHUNK,file.size)).arrayBuffer();
        if(token!==transferToken || remoteAbort) throw new Error(remoteAbort ? 'The receiver rejected or cancelled the transfer.' : 'Transfer cancelled.');
        const digest = await crypto.subtle.digest('SHA-256', chunk);
        const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        sendJson({kind:'chunk-start', size:chunk.byteLength, sha256:hash});
        channel.send(chunk); offset+=chunk.byteLength; sentBytes+=chunk.byteLength;
        progress(sentBytes,totalBytes,`Sending ${i+1}/${files.length}: ${file.name}`);
      }
      sendJson({kind:'file-end',id});
    }
    sendJson({kind:'batch-end'});
    setStatus(`All ${files.length} file(s) sent.`, 'good'); progress(totalBytes,totalBytes,'Sending complete');
  } catch (error) {
    try { if (channel && channel.readyState === 'open') sendJson({kind:'transfer-abort', reason:'Sender stopped the transfer.'}); } catch {}
    throw error;
  } finally {
    transferBusy = false;
    if (channel && channel.readyState === 'open') $('send-btn').disabled = false;
  }
}

function addReceivedText(text) {
  const row=document.createElement('div');row.className='file';const body=document.createElement('span');body.className='fname';body.textContent=text.length>5000?text.slice(0,5000)+'…':text;
  const copy=document.createElement('button');copy.className='btn inlinebtn';copy.type='button';copy.textContent='Copy';copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(text);setStatus('Received text copied.','good')}catch{setStatus('Clipboard access denied; select and copy text manually.','warn')}});
  row.append(body,copy);$('received-list').prepend(row);
}
function addReceivedFile(meta, blob) {
  const url=URL.createObjectURL(blob);receivedUrls.add(url);
  const row=document.createElement('div');row.className='file';
  const name=document.createElement('span');name.className='fname';name.textContent=`${meta.name} (${(meta.size/1048576).toFixed(2)} MB)`;
  const link=document.createElement('a');link.className='btn inlinebtn';link.href=url;link.download=meta.name;link.textContent='Download';
  row.append(name,link);$('received-list').prepend(row);
}
function handleMessage(event) {
  const data = event.data;
  messageQueue = messageQueue.then(() => processMessage(data)).catch(error => {
    setStatus(error.message || 'Error processing incoming data.', 'bad');
    if (channel && channel.readyState === 'open') { try { sendJson({kind:'transfer-abort', reason:'Receiver rejected invalid or incomplete data.'}); } catch {} }
    incoming = null; incomingParts = []; incomingBytes = 0; activeBatch = false;
  });
}
async function processMessage(data) {
  try {
    if (typeof data === 'string') {
      if (data.length > 128_000) throw new Error('Incoming control message is too large.');
      const msg=JSON.parse(data);
      if (!msg || typeof msg.kind!=='string') throw new Error('Unsupported message received.');
      if (msg.kind==='text') { if(typeof msg.text!=='string') throw new Error('Malformed text message.'); addReceivedText(msg.text); setStatus('Text received.','good'); }
      else if(msg.kind==='batch-start') {
        if (activeBatch || incoming) throw new Error('Another batch is already active.');
        if (!Number.isSafeInteger(msg.count) || msg.count < 1 || msg.count > 1000 || !Number.isSafeInteger(msg.totalBytes) || msg.totalBytes < 0) throw new Error('Invalid batch metadata.');
        if (msg.totalBytes > MAX_INCOMING_BYTES) throw new Error('This browser build can receive up to 512 MiB per batch because files are buffered in memory.');
        expectedFiles=msg.count; completedFiles=0; expectedTotalBytes=msg.totalBytes; receivedTotalBytes=0; activeBatch=true;
        setStatus(`Receiving ${expectedFiles} file(s)…`);progress(0,expectedTotalBytes,'Receiving files');
      }
      else if(msg.kind==='file-start') {
        if (!activeBatch) throw new Error('File arrived outside an active batch.');
        if(typeof msg.id!=='string'||msg.id.length>200||typeof msg.name!=='string'||!msg.name.trim()||msg.name.length>1024||!Number.isSafeInteger(msg.size)||msg.size<0||msg.size>MAX_INCOMING_BYTES) throw new Error('Invalid incoming file metadata.');
        if(incoming) throw new Error('A new file started before the previous file ended.');
        if (receivedTotalBytes + msg.size > expectedTotalBytes) throw new Error('Incoming files exceed the announced batch size.');
        incoming={id:msg.id,name:msg.name,size:msg.size,mime:typeof msg.mime==='string'?msg.mime:'application/octet-stream',lastModified:Number(msg.lastModified)||0};
        incomingParts=[];incomingBytes=0;
      } else if(msg.kind==='chunk-start') {
        if (!incoming || incoming.pendingChunk) throw new Error('Unexpected chunk metadata.');
        if (!Number.isSafeInteger(msg.size) || msg.size < 1 || msg.size > CHUNK || typeof msg.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(msg.sha256)) throw new Error('Invalid chunk metadata.');
        if (incomingBytes + msg.size > incoming.size) throw new Error('Chunk exceeds the announced file size.');
        incoming.pendingChunk = {size:msg.size, sha256:msg.sha256};
      } else if(msg.kind==='file-end') {
        if(!incoming||msg.id!==incoming.id) throw new Error('File end marker did not match the active file.');
        if(incoming.pendingChunk) throw new Error('File ended while a chunk was incomplete.');
        if(incomingBytes!==incoming.size) throw new Error(`File ${incoming.name} was incomplete (${incomingBytes} of ${incoming.size} bytes).`);
        finishIncomingFile();
      } else if(msg.kind==='batch-end') {
        if (!activeBatch || incoming || completedFiles !== expectedFiles || receivedTotalBytes !== expectedTotalBytes) throw new Error('Batch ended before all announced files and bytes arrived.');
        activeBatch=false; setStatus(`Receive complete: ${completedFiles} file(s).`,'good'); progress(receivedTotalBytes,expectedTotalBytes,'Receive complete');
      } else if (msg.kind==='transfer-abort') {
        remoteAbort=true; incoming=null; incomingParts=[]; incomingBytes=0; activeBatch=false; setStatus(typeof msg.reason==='string' ? msg.reason : 'The peer cancelled the transfer.','warn');
      } else throw new Error('Unknown message type.');
    } else if (data instanceof ArrayBuffer) {
      if(!incoming || !incoming.pendingChunk) throw new Error('Received binary data without valid chunk metadata.');
      const pending=incoming.pendingChunk;
      if(data.byteLength!==pending.size) throw new Error('Received chunk size does not match its metadata.');
      const digest=await crypto.subtle.digest('SHA-256',data);
      const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      if(hash!==pending.sha256) throw new Error('Chunk integrity check failed. The file was rejected.');
      incoming.pendingChunk=null; incomingParts.push(data);incomingBytes+=data.byteLength;receivedTotalBytes+=data.byteLength;
      progress(receivedTotalBytes,expectedTotalBytes,`Receiving: ${incoming.name}`);
    } else throw new Error('Unsupported incoming data format.');
  } catch (error) { throw error; }
}
function finishIncomingFile() {
  if(!incoming) return;
  const meta=incoming;const blob=new Blob(incomingParts,{type:meta.mime});
  addReceivedFile(meta,blob);completedFiles++;incoming=null;incomingParts=[];incomingBytes=0;
  setStatus(`Received ${meta.name}. Use Download to save it.`, 'good');
}
async function copyField(id) {
  const value=$(id).value;if(!value)return;
  try{await navigator.clipboard.writeText(value);setStatus('Copied pairing text to clipboard.','good');}
  catch{ $(id).focus();$(id).select();setStatus('Clipboard permission unavailable. Text selected; copy it manually.','warn'); }
}
function downloadText(id, filename) {
  const blob=new Blob([$(id).value],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function guard(fn) { return async () => { try { await fn(); } catch(e) { setStatus(e.message||'Operation failed.','bad'); } }; }

$('tab-files').addEventListener('click',()=>setMode('files'));$('tab-text').addEventListener('click',()=>setMode('text'));
$('file-input').addEventListener('change',e=>{selectedFiles=Array.from(e.target.files||[]);renderFiles();});
$('clear-btn').addEventListener('click',()=>{selectedFiles=[];$('file-input').value='';$('text-input').value='';renderFiles();});
$('prepare-btn').addEventListener('click',guard(makeOffer));$('send-btn').addEventListener('click',guard(sendPayload));
$('answer-btn').addEventListener('click',guard(makeAnswer));$('connect-btn').addEventListener('click',guard(applyAnswer));
$('copy-offer').addEventListener('click',()=>copyField('offer-out'));$('copy-answer').addEventListener('click',()=>copyField('answer-out'));
$('download-offer').addEventListener('click',()=>downloadText('offer-out','etembe-offer.json'));$('download-answer').addEventListener('click',()=>downloadText('answer-out','etembe-answer.json'));
$('disconnect-btn').addEventListener('click',()=>closePeer(true));
$('clear-received').addEventListener('click',()=>{$('received-list').replaceChildren();receivedUrls.forEach(URL.revokeObjectURL);receivedUrls.clear();});
$('secure-pill').textContent=window.isSecureContext?'Secure browser context':'HTTPS recommended';
if(!('RTCPeerConnection' in window)) setStatus('WebRTC is not supported in this browser. Use a current browser over HTTPS.','bad');
if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
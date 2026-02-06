// CONFIG
const DB_NAME = 'AutoPilotV26_Final';
const DB_VERSION = 3;
const CHANNEL_NAME = 'writer_core_v26';

let db = null;
let files = [];
let folders = [];
let logs = []; 
let checklists = {}; 
let currentFolderId = 'root';
let currentView = 'manager';
let previewFileId = null;
let currentFilter = 'all'; 

// QUEUE SYSTEM
let mergeQueue = []; 
let isProcessingQueue = false;

// BROADCAST CHANNEL
const commChannel = new BroadcastChannel(CHANNEL_NAME);

// --- DOM ELEMENTS ---
const els = {
    folderSelect: document.getElementById('folderSelect'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnRenameFolder: document.getElementById('btnRenameFolder'),
    btnDeleteFolder: document.getElementById('btnDeleteFolder'),
    searchInput: document.getElementById('searchInput'),
    
    btnViewFiles: document.getElementById('btnViewFiles'),
    btnViewHistory: document.getElementById('btnViewHistory'),
    btnViewChecklist: document.getElementById('btnViewChecklist'),
    views: {
        manager: document.getElementById('viewManager'),
        checklist: document.getElementById('viewChecklist'),
        history: document.getElementById('viewHistory')
    },

    fileGrid: document.getElementById('fileGrid'),
    fileCount: document.getElementById('fileCount'),
    selectAll: document.getElementById('selectAll'),
    btnDownloadBatch: document.getElementById('btnDownloadBatch'),
    btnDownloadDirect: document.getElementById('btnDownloadDirect'),
    btnDeleteBatch: document.getElementById('btnDeleteBatch'),

    checklistBody: document.getElementById('checklistBody'),
    btnClearChecklist: document.getElementById('btnClearChecklist'),
    progCount: document.getElementById('progCount'),
    progBar: document.getElementById('progBar'),
    
    historyTableBody: document.getElementById('historyTableBody'),
    historyFilters: document.querySelectorAll('.filter-btn'),
    btnClearHistory: document.getElementById('btnClearHistory'),

    autoGroup: document.getElementById('autoGroup'),
    previewModal: document.getElementById('previewModal'),
    previewTitle: document.getElementById('previewTitle'), // Tên file trên thanh modal
    previewDocHeader: document.getElementById('previewDocHeader'), // Header trong nội dung
    previewBody: document.getElementById('previewBody'),
    toast: document.getElementById('toast'),
    
    editor: { value: '' }, 
    chapterTitle: { value: '' }
};

// --- HELPERS ---
// Chuẩn Word: Tách theo khoảng trắng bất kỳ và loại bỏ rỗng
function countWords(text) { 
    if (!text) return 0; 
    return text.trim().split(/[\s\u200B]+/).filter(i => i).length; 
}

function cleanContent(text) { 
    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0); 
}

// Phân tích tiêu đề: Trả về { num: 87.1, groupNum: 87, titleText: "Chúng ta kết hôn nhé" }
function analyzeTitle(rawTitle) {
    // Regex bắt: (Chương/Chapter...) (Số) (Dấu ngăn cách) (Tên chương)
    // VD: Chương 87.1: ABC -> Group 1=87.1, Group 3=ABC
    const match = rawTitle.match(/(?:Chương|Chapter|Hồi|Quyển)\s*(\d+(?:\.\d+)?)(?:[:\s\-\.]+(.*))?/i);
    
    if (!match) return { num: 999999, groupNum: null, titleText: "" };
    
    const num = parseFloat(match[1]);
    const groupNum = parseInt(match[1], 10);
    const titleText = match[2] ? match[2].trim() : "";
    
    return { num, groupNum, titleText };
}

// --- INIT ---
async function init() {
    await initDB();
    setupEvents();
    localStorage.setItem('is_merging_busy', 'false');
    
    commChannel.onmessage = (event) => {
        const data = event.data;
        if (!data) return;
        if (data.type === 'MERGE') {
            mergeQueue.push({
                title: data.payload.title,
                content: data.payload.content,
                autoGroup: els.autoGroup.checked
            });
            processQueue();
        }
        if (data.type === 'CHECKLIST') {
            importChecklist(data.payload);
        }
    };

    window.addEventListener('visibilitychange', () => {
        if (!document.hidden && mergeQueue.length > 0) processQueue();
    });
}

function setupEvents() {
    els.btnNewFolder.onclick = createFolder;
    els.btnDeleteFolder.onclick = deleteCurrentFolder;
    if(els.btnRenameFolder) els.btnRenameFolder.onclick = renameFolder;
    els.folderSelect.onchange = (e) => { currentFolderId = e.target.value; switchView(currentView); };
    
    els.btnViewFiles.onclick = () => switchView('manager');
    els.btnViewHistory.onclick = () => switchView('history');
    els.btnViewChecklist.onclick = () => switchView('checklist');
    
    els.searchInput.oninput = () => { 
        if (currentView === 'manager') renderFiles();
        if (currentView === 'history') renderHistory();
    };

    els.btnClearChecklist.onclick = clearChecklist;
    els.btnClearHistory.onclick = clearHistory;
    els.selectAll.onchange = (e) => { getFilteredFiles().forEach(f => f.selected = e.target.checked); renderFiles(); };
    els.btnDownloadBatch.onclick = downloadBatchZip;
    els.btnDownloadDirect.onclick = downloadBatchDirect;
    els.btnDeleteBatch.onclick = deleteBatch;

    els.historyFilters.forEach(btn => {
        btn.onclick = () => {
            els.historyFilters.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderHistory();
        };
    });

    document.addEventListener('keydown', e => {
        if(els.previewModal.classList.contains('show')) {
            if(e.key === 'ArrowLeft') prevChapter();
            if(e.key === 'ArrowRight') nextChapter();
            if(e.key === 'Escape') closePreview();
        }
    });
}

// --- QUEUE PROCESSOR ---
async function processQueue() {
    if (isProcessingQueue) return;
    if (mergeQueue.length === 0) {
        localStorage.setItem('is_merging_busy', 'false');
        return;
    }
    isProcessingQueue = true;
    localStorage.setItem('is_merging_busy', 'true');
    try {
        const task = mergeQueue.shift();
        await performMerge(task);
    } catch (e) {
        console.error("Lỗi:", e);
        addLog('warn', `Lỗi: ${e.message}`);
    } finally {
        isProcessingQueue = false;
        setTimeout(processQueue, 50); 
    }
}

// --- CORE MERGE LOGIC (SMART) ---
async function performMerge(task) {
    const { title: inputTitle, content, autoGroup } = task;
    if (!content || !content.trim()) return;

    // Phân tích tiêu đề đầu vào
    const info = analyzeTitle(inputTitle);
    const lines = cleanContent(content);
    
    // Tên file gốc (Safe)
    let baseFileName = inputTitle.replace(/[:*?"<>|]/g, " -").trim(); 
    let finalFileName = `${baseFileName}.docx`;
    
    // Tiêu đề hiển thị trong Doc (Mặc định là input gốc)
    let docHeader = inputTitle; 

    // Logic Gộp Thông Minh
    if (autoGroup && info.groupNum !== null) {
        // Nếu có Title Text (vd: "Chúng ta kết hôn nhé")
        if (info.titleText) {
            // Tên file: Chương 87 - Chúng ta kết hôn nhé.docx
            finalFileName = `Chương ${info.groupNum} - ${info.titleText}.docx`;
            // Header: Chương 87: Chúng ta kết hôn nhé
            docHeader = `Chương ${info.groupNum}: ${info.titleText}`;
        } else {
            // Nếu không có title text, chỉ là Chương 87.docx
            finalFileName = `Chương ${info.groupNum}.docx`;
            docHeader = `Chương ${info.groupNum}`;
        }
    }

    let segment = { idSort: info.num, lines: lines, header: inputTitle };
    
    // Tìm file tương ứng trong DB
    // Logic tìm file: 
    // 1. Tìm chính xác tên file finalFileName
    // 2. HOẶC tìm file "Chương X.docx" nếu đang gộp vào đó (để update tên file nếu có title mới)
    
    let targetFile = files.find(f => f.folderId === currentFolderId && (f.name === finalFileName || (autoGroup && f.name.startsWith(`Chương ${info.groupNum}`))));

    if (targetFile) {
        if (!targetFile.segments) targetFile.segments = [];
        
        // Cập nhật tên file và Header nếu có title mới (Ưu tiên title dài hơn)
        if (autoGroup && info.titleText && targetFile.name.length < finalFileName.length) {
             targetFile.name = finalFileName;
             targetFile.headerInDoc = docHeader;
        }

        const existingIndex = targetFile.segments.findIndex(s => s.idSort === info.num);
        if (existingIndex !== -1) {
            targetFile.segments[existingIndex] = segment;
            addLog('warn', `Cập nhật: ${inputTitle}`);
        } else {
            targetFile.segments.push(segment);
            addLog('success', `Gộp: ${inputTitle}`);
        }

        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        
        // Tính lại word count chuẩn Word (Header + Content)
        let allText = targetFile.headerInDoc + " "; 
        targetFile.segments.forEach(seg => { allText += seg.lines.join(' ') + ' '; });
        
        targetFile.wordCount = countWords(allText);
        targetFile.timestamp = Date.now();
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        saveDB('files', targetFile);
    } else {
        // Tạo mới
        let allText = docHeader + " " + lines.join(' ');
        targetFile = {
            id: Date.now(), 
            name: finalFileName, 
            folderId: currentFolderId,
            segments: [segment],
            headerInDoc: docHeader,
            wordCount: countWords(allText), 
            timestamp: Date.now(), 
            selected: false
        };
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        files.push(targetFile);
        saveDB('files', targetFile);
        addLog('info', `Mới: ${inputTitle}`);
    }

    if (currentView === 'manager') renderFiles();
    if (currentView === 'checklist') renderChecklist();
    toast(`✅ ${inputTitle}`);
}

// --- DOCX GENERATOR (V26.7 FORMAT) ---
function generateDocxFromSegments(mainHeader, segments) { 
    const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx; 
    const children = []; 
    
    // 1. Tiêu đề: Căn trái, Không đậm, Size 16pt, Cách 1 dòng
    children.push(new Paragraph({
        children: [new TextRun({
            text: mainHeader, 
            font: "Calibri", 
            size: 32, 
            bold: false, // Yêu cầu: Không in đậm
            color: "000000"
        })], 
        alignment: AlignmentType.LEFT,
        spacing: { after: 240 } // Cách 1 dòng (240twip ~ 12pt)
    })); 
    
    // Dòng trắng sau tiêu đề
    children.push(new Paragraph({ text: "", spacing: { after: 240 } }));

    // 2. Nội dung
    segments.forEach(seg => { 
        seg.lines.forEach(line => { 
            children.push(new Paragraph({
                children: [new TextRun({
                    text: line, 
                    font: "Calibri", 
                    size: 32, // 16pt
                    color: "000000"
                })], 
                spacing: { after: 240 }, // Cách 1 dòng giữa các đoạn
                alignment: AlignmentType.LEFT // Căn trái
            })); 
        }); 
        // Không thêm khoảng cách thừa giữa các phần gộp, vì đã có dòng trắng ở mỗi đoạn
    }); 
    
    return Packer.toBlob(new Document({sections:[{children}]})); 
}

// --- PREVIEW SYSTEM ---
window.openPreview = (id) => { 
    const f=files.find(x=>x.id===id); if(!f) return; previewFileId=id; 
    const list = getFilteredFiles(); 
    const idx = list.findIndex(x=>x.id===id);
    
    // Cập nhật bộ đếm trong Modal
    const counterEl = document.querySelector('.modal-counter');
    if(counterEl) counterEl.innerText = `Chương ${idx + 1} / ${list.length}`;
    
    // Tên file trên thanh tiêu đề modal
    els.previewTitle.innerText = f.name; 
    
    // Header trong nội dung preview (Đúng format tải về)
    els.previewDocHeader.innerText = f.headerInDoc; 
    // CSS trực tiếp cho giống DOCX
    els.previewDocHeader.style.textAlign = 'left';
    els.previewDocHeader.style.fontFamily = 'Calibri';
    els.previewDocHeader.style.fontSize = '16pt';
    els.previewDocHeader.style.fontWeight = 'normal'; // Không in đậm
    els.previewDocHeader.style.marginBottom = '1em'; // Cách 1 dòng

    let content = ""; 
    // Dòng trắng sau header
    content += "<div style='height: 1.2em'></div>";

    if(f.segments) {
        f.segments.forEach(s => { 
            s.lines.forEach(l => {
                // Cách 1 dòng giữa các đoạn
                content += `<p style="font-family:Calibri; font-size:16pt; margin-bottom:1.2em; text-align:left; line-height:1.5">${l}</p>`;
            }); 
        }); 
    } else {
        content = f.rawContent.split('\n').map(l=>`<p style="font-family:Calibri; font-size:16pt; margin-bottom:1.2em">${l}</p>`).join(''); 
    }
    
    els.previewBody.innerHTML = content; 
    els.previewModal.classList.add('show'); 
};

window.closePreview = () => els.previewModal.classList.remove('show');
window.prevChapter = () => { const l=getFilteredFiles(); const i=l.findIndex(x=>x.id===previewFileId); if(i>0) openPreview(l[i-1].id); else toast("Đầu danh sách"); };
window.nextChapter = () => { const l=getFilteredFiles(); const i=l.findIndex(x=>x.id===previewFileId); if(i!==-1 && i<l.length-1) openPreview(l[i+1].id); else toast("Hết danh sách"); };

// --- RENDERERS ---
function renderFiles() { 
    const list = getFilteredFiles(); 
    els.fileCount.innerText = list.length; 
    els.fileGrid.innerHTML = ''; 
    list.forEach(f => { 
        // LOGIC HIỂN THỊ TÊN GỌN TRONG MANAGER
        // Nếu tên file là "Chương 87 - ABC.docx" -> Hiển thị "Chương 87"
        // Nếu không parse được thì hiển thị nguyên tên
        let displayName = f.name.replace('.docx', '');
        if (displayName.includes('-')) {
             const parts = displayName.split('-');
             if (parts[0].trim().startsWith('Chương')) {
                 displayName = parts[0].trim(); // Chỉ lấy "Chương 87"
             }
        }

        const card = document.createElement('div'); 
        card.className = `file-card ${f.selected ? 'selected' : ''}`; 
        card.onclick = (e) => { 
            if(e.target.closest('.action-pill')) return; 
            f.selected = !f.selected; 
            renderFiles(); 
        }; 
        card.innerHTML = `
            <div class="card-icon">📄</div>
            <div class="file-name" title="${f.name}">${displayName}</div>
            <div class="file-meta">${f.wordCount} từ</div>
            <div style="margin-top:auto;display:flex;gap:5px">
                <button class="action-pill" onclick="openPreview(${f.id})">Xem</button>
                <button class="action-pill danger" onclick="deleteOne(${f.id})">Xóa</button>
            </div>`; 
        els.fileGrid.appendChild(card); 
    }); 
}

// ... (Các hàm Checklist, History, DB giữ nguyên như V26.5) ...
function renderFolders() { els.folderSelect.innerHTML = ''; folders.forEach(f => { const o = document.createElement('option'); o.value = f.id; o.innerText = f.name; if(f.id===currentFolderId) o.selected=true; els.folderSelect.appendChild(o); }); }
function renderHistory() { let filtered = logs; if (currentFilter === 'scan') filtered = logs.filter(l => l.type.startsWith('scan')); else if (currentFilter === 'merge') filtered = logs.filter(l => l.type === 'merge'); const keyword = els.searchInput.value.toLowerCase(); if(keyword) filtered = filtered.filter(l => l.msg.toLowerCase().includes(keyword)); els.historyTableBody.innerHTML = ''; if (filtered.length === 0) { els.historyTableBody.innerHTML = '<div style="padding:20px;text-align:center;color:#999">Trống.</div>'; return; } const frag = document.createDocumentFragment(); filtered.forEach(log => { const tr = document.createElement('div'); tr.className = 'table-row'; let badgeClass = 'info'; let badgeText = 'Gộp'; if(log.type === 'scan_dupe') { badgeClass = 'error'; badgeText = 'Trùng'; } else if(log.type === 'scan_ok') { badgeClass = 'success'; badgeText = 'Sạch'; } else if(log.type === 'warn') { badgeClass = 'error'; badgeText = 'Lỗi'; } tr.innerHTML = `<div class="col-time">${log.time}</div><div class="col-type"><span class="badge ${badgeClass}">${badgeText}</span></div><div class="col-msg" title="${log.msg}">${log.msg}</div>`; frag.appendChild(tr); }); els.historyTableBody.appendChild(frag); }
function renderChecklist() { const list = checklists[currentFolderId] || []; const currentFiles = files.filter(f => f.folderId === currentFolderId); const doneChapters = new Set(); currentFiles.forEach(f => { if(f.segments && f.segments.length > 0) f.segments.forEach(s => doneChapters.add(s.idSort)); else doneChapters.add(getChapterNum(f.name)); }); els.checklistBody.innerHTML = ''; let doneCount = 0; if(list.length === 0) { els.checklistBody.innerHTML = '<div style="padding:40px;text-align:center;color:#9ca3af;font-style:italic">Chưa có danh sách. Ấn F2 bên web truyện để quét.</div>'; } else { const frag = document.createDocumentFragment(); list.forEach(item => { const isDone = doneChapters.has(item.num); if(isDone) doneCount++; const div = document.createElement('div'); div.className = `checklist-item ${isDone ? 'done' : ''}`; let statusHtml = isDone ? `<span class="status-badge done">✔ Đã xong</span>` : `<span class="status-badge pending"><span class="spinner"></span> Chờ</span>`; div.innerHTML = `<div class="col-status">${statusHtml}</div><div class="col-name">${item.title}</div><div class="col-idx">#${item.num}</div>`; frag.appendChild(div); }); els.checklistBody.appendChild(frag); } els.progCount.innerText = `${doneCount}/${list.length}`; const percent = list.length > 0 ? (doneCount / list.length) * 100 : 0; els.progBar.style.width = `${percent}%`; }
function addLog(type, msg) { const now = new Date(); const time = now.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', second:'2-digit'}); const item = { id: Date.now(), time, type, msg, timestamp: now.getTime() }; logs.unshift(item); if(logs.length > 300) logs.pop(); saveDB('history', item); if(currentView === 'history') renderHistory(); }
function updateFilterUI() { els.historyFilters.forEach(b => { b.classList.toggle('active', b.dataset.filter === currentFilter); }); }
function getAll(s) { return new Promise(r => db.transaction(s,'readonly').objectStore(s).getAll().onsuccess=e=>r(e.target.result||[])); }
function saveDB(s, i) { db.transaction(s,'readwrite').objectStore(s).put(i); }
function delDB(s, id) { db.transaction(s,'readwrite').objectStore(s).delete(id); }
function clearStore(s) { db.transaction(s, 'readwrite').objectStore(s).clear(); }
function toast(m) { els.toast.innerText = m; els.toast.classList.add('show'); setTimeout(()=>els.toast.classList.remove('show'), 2000); }
function getFilteredFiles() { let l = files.filter(f=>f.folderId===currentFolderId); if(currentView==='manager'){ const k=els.searchInput.value.toLowerCase(); if(k) l=l.filter(f=>f.name.toLowerCase().includes(k)); } return l.sort((a,b)=>getChapterNum(a.name)-getChapterNum(b.name)); }
function importChecklist(items) { if(!items || items.length === 0) return; const seen = new Set(); const duplicates = []; items.forEach(item => { if(seen.has(item.num)) duplicates.push(item.num); else seen.add(item.num); }); if(duplicates.length > 0) { const uniqueDupes = [...new Set(duplicates)].sort((a,b)=>a-b); addLog('scan_dupe', `Trùng chương: ${uniqueDupes.join(', ')}`); toast(`⚠️ Có ${uniqueDupes.length} chương trùng!`); switchView('history'); currentFilter = 'scan'; updateFilterUI(); } else { addLog('scan_ok', `Quét ${items.length} chương: Sạch sẽ.`); toast(`📋 Đã nhập ${items.length} chương.`); } let currentList = checklists[currentFolderId] || []; items.forEach(item => { if(!currentList.find(x => x.num === item.num)) currentList.push(item); }); currentList.sort((a,b) => a.num - b.num); checklists[currentFolderId] = currentList; saveDB('checklists', {folderId: currentFolderId, list: currentList}); renderChecklist(); renderHistory(); }
function clearChecklist() { if(confirm("Xóa danh sách?")) { delete checklists[currentFolderId]; delDB('checklists', currentFolderId); renderChecklist(); toast("Đã xóa"); } }
function clearHistory() { if(confirm("Xóa nhật ký?")) { logs=[]; clearStore('history'); renderHistory(); toast("Đã dọn dẹp"); } }
function createFolder() { const n = prompt("Tên folder:"); if(n) { const f={id:Date.now().toString(), name:n}; folders.push(f); saveDB('folders', f); currentFolderId=f.id; renderFolders(); renderFiles(); } }
function renameFolder() { const c = folders.find(f=>f.id===currentFolderId); if(!c) return; const n = prompt("Đổi tên:", c.name); if(n){ c.name=n.trim(); saveDB('folders', c); renderFolders(); toast("Đã đổi tên"); } }
function deleteCurrentFolder() { if(confirm("Xóa folder này?")) { files.filter(f=>f.folderId===currentFolderId).forEach(f=>delDB('files',f.id)); delDB('folders', currentFolderId); files=files.filter(f=>f.folderId!==currentFolderId); folders=folders.filter(f=>f.id!==currentFolderId); if(folders.length===0){folders.push({id:'root',name:'Thư mục chính'});saveDB('folders',{id:'root',name:'Thư mục chính'});} currentFolderId=folders[0].id; renderFolders(); renderFiles(); switchView(currentView); toast("Đã xóa"); } }
function initDB() { return new Promise(r => { const req = indexedDB.open(DB_NAME, DB_VERSION); req.onupgradeneeded = e => { const d = e.target.result; if(!d.objectStoreNames.contains('files')) d.createObjectStore('files', {keyPath: 'id'}); if(!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', {keyPath: 'id'}); if(!d.objectStoreNames.contains('history')) d.createObjectStore('history', {keyPath: 'id'}); if(!d.objectStoreNames.contains('checklists')) d.createObjectStore('checklists', {keyPath: 'folderId'}); }; req.onsuccess = e => { db = e.target.result; loadData().then(r); }; }); }
async function loadData() { files = await getAll('files'); folders = await getAll('folders'); logs = (await getAll('history')).sort((a,b)=>b.timestamp-a.timestamp); const c = await getAll('checklists'); c.forEach(i => checklists[i.folderId] = i.list); if(folders.length === 0) { folders.push({id:'root', name:'Thư mục chính'}); saveDB('folders', {id:'root', name:'Thư mục chính'}); } if(!folders.find(f=>f.id===currentFolderId)) currentFolderId = folders[0].id; renderFolders(); renderFiles(); renderHistory(); }
window.deleteOne = (id) => { if(confirm('Xóa file?')) { delDB('files', id); files=files.filter(f=>f.id!==id); renderFiles(); } };
function deleteBatch() { const s=getFilteredFiles().filter(f=>f.selected); if(confirm(`Xóa ${s.length} file?`)) { s.forEach(f=>delDB('files',f.id)); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function downloadBatchZip() { const s=getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn"); const z=new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c,`Batch_${Date.now()}.zip`)); }
async function downloadBatchDirect() { const s=getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn"); for(let f of s) { if(f.blob) { saveAs(f.blob, f.name); await new Promise(r=>setTimeout(r,300)); } } }

init();

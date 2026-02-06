// CONFIG
const DB_NAME = 'AutoPilotV26_Final';
const DB_VERSION = 3;
const CHANNEL_NAME = 'writer_core_v26';

let db = null;
let files = [];
let folders = [];
let logs = []; // Sử dụng mảng logs chung thay vì historyLogs
let checklists = {}; 
let currentFolderId = 'root';
let currentView = 'manager';
let previewFileId = null;
let currentFilter = 'all'; // Biến theo dõi bộ lọc hiện tại

// QUEUE SYSTEM
let mergeQueue = []; 
let isProcessingQueue = false;

// BROADCAST CHANNEL (Cầu nối nhận tin)
const commChannel = new BroadcastChannel(CHANNEL_NAME);

// --- DOM ELEMENTS ---
// (Đã map lại chính xác theo HTML V26)
const els = {
    folderSelect: document.getElementById('folderSelect'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnRenameFolder: document.getElementById('btnRenameFolder'), // Mới
    btnDeleteFolder: document.getElementById('btnDeleteFolder'),
    searchInput: document.getElementById('searchInput'),
    
    // View Tabs
    btnViewFiles: document.getElementById('btnViewFiles'),
    btnViewHistory: document.getElementById('btnViewHistory'),
    btnViewChecklist: document.getElementById('btnViewChecklist'),
    views: {
        manager: document.getElementById('viewManager'),
        checklist: document.getElementById('viewChecklist'),
        history: document.getElementById('viewHistory')
    },

    // Manager Actions
    fileGrid: document.getElementById('fileGrid'),
    fileCount: document.getElementById('fileCount'),
    selectAll: document.getElementById('selectAll'),
    btnDownloadBatch: document.getElementById('btnDownloadBatch'),
    btnDownloadDirect: document.getElementById('btnDownloadDirect'),
    btnDeleteBatch: document.getElementById('btnDeleteBatch'),

    // Checklist
    checklistBody: document.getElementById('checklistBody'),
    btnClearChecklist: document.getElementById('btnClearChecklist'),
    progCount: document.getElementById('progCount'),
    progBar: document.getElementById('progBar'),
    
    // History & Filter (SỬA LỖI Ở ĐÂY)
    historyTableBody: document.getElementById('historyTableBody'),
    historyFilters: document.querySelectorAll('.filter-btn'), // Lấy danh sách nút thay vì select
    btnClearHistory: document.getElementById('btnClearHistory'),

    // Hidden & Modal
    autoGroup: document.getElementById('autoGroup'),
    previewModal: document.getElementById('previewModal'),
    previewTitle: document.getElementById('previewTitle'),
    previewDocHeader: document.getElementById('previewDocHeader'),
    previewBody: document.getElementById('previewBody'),
    toast: document.getElementById('toast'),
    
    // Fake elements for logic compatibility
    editor: { value: '' }, 
    chapterTitle: { value: '' }
};

// --- HELPERS ---
function countWords(text) { 
    if (!text || !text.trim()) return 0; 
    return text.trim().split(/\s+/).length; 
}
// 1.5 -> 1.5
function getChapterNum(title) { 
    const match = title.match(/(?:Chương|Chapter|Hồi)\s*(\d+(\.\d+)?)/i); 
    return match ? parseFloat(match[1]) : 999999; 
}
// 1.5 -> 1
function getGroupNum(title) {
    const match = title.match(/(?:Chương|Chapter|Hồi)\s*(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
}
function cleanContent(text) { 
    return text.split('\n').map(l => l.trim()).filter(l => l.length > 0); 
}

// --- INIT ---
async function init() {
    await initDB();
    setupEvents();
    
    // Reset trạng thái bận
    localStorage.setItem('is_merging_busy', 'false');
    
    // LẮNG NGHE TÍN HIỆU TỪ TAMPERMONKEY
    commChannel.onmessage = (event) => {
        const data = event.data;
        if (!data) return;

        console.log("Web App received:", data); // Debug log

        if (data.type === 'MERGE') {
            // Đẩy vào hàng đợi xử lý
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

    // Backup check (nếu tab bị ẩn)
    window.addEventListener('visibilitychange', () => {
        if (!document.hidden && mergeQueue.length > 0) processQueue();
    });
}

function setupEvents() {
    // Folder Ops
    els.btnNewFolder.onclick = createFolder;
    els.btnDeleteFolder.onclick = deleteCurrentFolder;
    if(els.btnRenameFolder) els.btnRenameFolder.onclick = renameFolder;
    
    els.folderSelect.onchange = (e) => { currentFolderId = e.target.value; switchView(currentView); };
    
    // Navigation
    els.btnViewFiles.onclick = () => switchView('manager');
    els.btnViewHistory.onclick = () => switchView('history');
    els.btnViewChecklist.onclick = () => switchView('checklist');
    
    // Search
    els.searchInput.oninput = () => { 
        if (currentView === 'manager') renderFiles();
        if (currentView === 'history') renderHistory();
    };

    // Cleaners
    els.btnClearChecklist.onclick = clearChecklist;
    els.btnClearHistory.onclick = clearHistory;

    // Batch Ops
    els.selectAll.onchange = (e) => { getFilteredFiles().forEach(f => f.selected = e.target.checked); renderFiles(); };
    els.btnDownloadBatch.onclick = downloadBatchZip;
    els.btnDownloadDirect.onclick = downloadBatchDirect;
    els.btnDeleteBatch.onclick = deleteBatch;

    // FIX LỖI 1: Setup Filter Buttons (Thay vì select box cũ)
    els.historyFilters.forEach(btn => {
        btn.onclick = () => {
            // UI Update
            els.historyFilters.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Logic Update
            currentFilter = btn.dataset.filter; // 'all', 'scan', 'merge'
            renderHistory();
        };
    });

    // Preview Keys
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
        console.error("Lỗi xử lý:", e);
        addLog('warn', `Lỗi xử lý: ${e.message}`);
    } finally {
        isProcessingQueue = false;
        setTimeout(processQueue, 50); 
    }
}

// --- CORE MERGE LOGIC (SMART 1.x -> 1) ---
async function performMerge(task) {
    const { title: inputTitle, content, autoGroup } = task;
    if (!content || !content.trim()) return;

    let safeName = inputTitle.replace(/[:*?"<>|]/g, " -").trim();
    let fileName = `${safeName}.docx`; 
    
    const lines = cleanContent(content);
    const chapterNum = getChapterNum(inputTitle); // 1.1
    const groupNum = getGroupNum(inputTitle);     // 1
    
    let segment = { 
        idSort: chapterNum, 
        lines: lines, 
        header: inputTitle 
    };

    // Logic đặt tên file gộp
    if (autoGroup && groupNum !== null) {
        fileName = `Chương ${groupNum}.docx`;
    }

    let targetFile = files.find(f => f.name === fileName && f.folderId === currentFolderId);
    let logMsg = '';

    if (targetFile) {
        if (!targetFile.segments) targetFile.segments = [];
        
        const existingIndex = targetFile.segments.findIndex(s => s.idSort === chapterNum);
        
        if (existingIndex !== -1) {
            targetFile.segments[existingIndex] = segment;
            logMsg = `Cập nhật: ${inputTitle}`;
        } else {
            targetFile.segments.push(segment);
            logMsg = `Gộp thêm: ${inputTitle} vào ${fileName}`;
        }

        // SẮP XẾP LẠI (1.1 trước 1.2)
        targetFile.segments.sort((a,b) => a.idSort - b.idSort);
        
        // Rebuild Text để đếm từ
        let allText = "";
        targetFile.segments.forEach(seg => { allText += seg.lines.join(' ') + ' '; });

        targetFile.headerInDoc = fileName.replace('.docx', '');
        targetFile.wordCount = countWords(allText);
        targetFile.timestamp = Date.now();
        
        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        saveDB('files', targetFile);
        
    } else {
        // TẠO FILE MỚI
        const wc = countWords(content);
        
        targetFile = {
            id: Date.now(), 
            name: fileName, 
            folderId: currentFolderId,
            segments: [segment],
            headerInDoc: (autoGroup && groupNum !== null) ? `Chương ${groupNum}` : inputTitle,
            wordCount: wc, 
            timestamp: Date.now(), 
            selected: false
        };

        targetFile.blob = await generateDocxFromSegments(targetFile.headerInDoc, targetFile.segments);
        files.push(targetFile);
        saveDB('files', targetFile);
        
        logMsg = `Tạo mới: ${fileName}`;
    }

    addLog('merge', logMsg);
    if (currentView === 'manager') renderFiles();
    if (currentView === 'checklist') renderChecklist();
    toast(`✅ ${inputTitle}`);
}

// --- CHECKLIST LOGIC ---
function importChecklist(items) {
    if(!items || items.length === 0) return;
    const seen = new Set();
    const duplicates = [];
    
    items.forEach(item => {
        if(seen.has(item.num)) duplicates.push(item.num);
        else seen.add(item.num);
    });

    if(duplicates.length > 0) {
        const uniqueDupes = [...new Set(duplicates)].sort((a,b)=>a-b);
        addLog('scan_dupe', `Trùng chương: ${uniqueDupes.join(', ')}`);
        toast(`⚠️ Có ${uniqueDupes.length} chương trùng!`);
        
        // Auto switch to History & Scan Tab
        switchView('history'); 
        currentFilter = 'scan';
        updateFilterUI();
    } else {
        addLog('scan_ok', `Quét ${items.length} chương: Sạch sẽ.`);
        toast(`📋 Đã nhập ${items.length} chương.`);
    }

    let currentList = checklists[currentFolderId] || [];
    items.forEach(item => {
        if(!currentList.find(x => x.num === item.num)) currentList.push(item);
    });
    currentList.sort((a,b) => a.num - b.num);
    checklists[currentFolderId] = currentList;
    saveDB('checklists', {folderId: currentFolderId, list: currentList});
    
    renderChecklist();
    renderHistory();
}

function renderChecklist() {
    const list = checklists[currentFolderId] || [];
    const currentFiles = files.filter(f => f.folderId === currentFolderId);
    const doneChapters = new Set();
    
    currentFiles.forEach(f => {
        if(f.segments && f.segments.length > 0) f.segments.forEach(s => doneChapters.add(s.idSort));
        else doneChapters.add(getChapterNum(f.name));
    });

    els.checklistBody.innerHTML = '';
    let doneCount = 0;

    if(list.length === 0) {
        els.checklistBody.innerHTML = '<div style="padding:40px;text-align:center;color:#9ca3af;font-style:italic">Chưa có danh sách. Ấn F2 bên web truyện để quét.</div>';
    } else {
        const frag = document.createDocumentFragment();
        list.forEach(item => {
            const isDone = doneChapters.has(item.num);
            if(isDone) doneCount++;
            
            const div = document.createElement('div');
            div.className = `checklist-item ${isDone ? 'done' : ''}`;
            
            // HTML Status
            let statusHtml = isDone 
                ? `<span class="status-badge done">✔ Đã xong</span>`
                : `<span class="status-badge pending"><span class="spinner"></span> Chờ</span>`;

            div.innerHTML = `
                <div class="col-status">${statusHtml}</div>
                <div class="col-name">${item.title}</div>
                <div class="col-idx">#${item.num}</div>
            `;
            frag.appendChild(div);
        });
        els.checklistBody.appendChild(frag);
    }
    
    els.progCount.innerText = `${doneCount}/${list.length}`;
    const percent = list.length > 0 ? (doneCount / list.length) * 100 : 0;
    els.progBar.style.width = `${percent}%`;
}

// --- HISTORY SYSTEM (FIX LỖI 2) ---
function addLog(type, msg) {
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const item = { id: Date.now(), time, type, msg, timestamp: now.getTime() };
    logs.unshift(item);
    if(logs.length > 300) logs.pop();
    saveDB('history', item);
    
    if(currentView === 'history') renderHistory();
}

function renderHistory() {
    let filtered = logs;
    
    // FIX LOGIC FILTER: Dùng biến currentFilter thay vì đọc value của nút
    if (currentFilter === 'scan') filtered = logs.filter(l => l.type.startsWith('scan'));
    else if (currentFilter === 'merge') filtered = logs.filter(l => l.type === 'merge');
    
    const keyword = els.searchInput.value.toLowerCase();
    if(keyword) filtered = filtered.filter(l => l.msg.toLowerCase().includes(keyword));

    els.historyTableBody.innerHTML = '';
    if (filtered.length === 0) {
        els.historyTableBody.innerHTML = '<div style="padding:20px;text-align:center;color:#999">Trống.</div>';
        return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach(log => {
        const tr = document.createElement('div');
        tr.className = 'table-row';
        
        let badgeClass = 'info';
        let badgeText = 'Gộp';
        if(log.type === 'scan_dupe') { badgeClass = 'error'; badgeText = 'Trùng'; }
        else if(log.type === 'scan_ok') { badgeClass = 'success'; badgeText = 'Sạch'; }
        else if(log.type === 'warn') { badgeClass = 'error'; badgeText = 'Lỗi'; }
        
        tr.innerHTML = `
            <div class="col-time">${log.time}</div>
            <div class="col-type"><span class="badge ${badgeClass}">${badgeText}</span></div>
            <div class="col-msg" title="${log.msg}">${log.msg}</div>
        `;
        frag.appendChild(tr);
    });
    els.historyTableBody.appendChild(frag);
}

function updateFilterUI() {
    els.historyFilters.forEach(b => {
        b.classList.toggle('active', b.dataset.filter === currentFilter);
    });
}

// --- GENERATOR DOCX (Calibri 32 = 16pt) ---
function generateDocxFromSegments(mainHeader, segments) { 
    const { Document, Packer, Paragraph, TextRun, AlignmentType } = docx; 
    const children = []; 
    
    children.push(new Paragraph({
        children: [new TextRun({text: mainHeader, font: "Calibri", size: 48, bold: true})], 
        alignment: AlignmentType.CENTER,
        spacing: {after: 400}
    })); 
    
    segments.forEach(seg => { 
        if (seg.header !== mainHeader) {
             children.push(new Paragraph({
                children: [new TextRun({text: seg.header, font: "Calibri", size: 36, bold: true, color: "2E74B5"})],
                spacing: {before: 300, after: 200}
            }));
        }

        seg.lines.forEach(line => { 
            children.push(new Paragraph({
                children: [new TextRun({
                    text: line, 
                    font: "Calibri", 
                    size: 32 // 16pt
                })], 
                spacing: {after: 240},
                alignment: AlignmentType.JUSTIFIED
            })); 
        }); 
        
        children.push(new Paragraph({text: "", spacing: {after: 200}}));
    }); 
    
    return Packer.toBlob(new Document({sections:[{children}]})); 
}

// --- FOLDER & DB ---
function initDB() { return new Promise(r => { const req = indexedDB.open(DB_NAME, DB_VERSION); req.onupgradeneeded = e => { const d = e.target.result; if(!d.objectStoreNames.contains('files')) d.createObjectStore('files', {keyPath: 'id'}); if(!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', {keyPath: 'id'}); if(!d.objectStoreNames.contains('history')) d.createObjectStore('history', {keyPath: 'id'}); if(!d.objectStoreNames.contains('checklists')) d.createObjectStore('checklists', {keyPath: 'folderId'}); }; req.onsuccess = e => { db = e.target.result; loadData().then(r); }; }); }

async function loadData() { 
    files = await getAll('files'); 
    folders = await getAll('folders'); 
    logs = (await getAll('history')).sort((a,b)=>b.timestamp-a.timestamp); 
    const c = await getAll('checklists'); 
    c.forEach(i => checklists[i.folderId] = i.list); 
    
    if(folders.length === 0) { 
        folders.push({id:'root', name:'Thư mục chính'}); 
        saveDB('folders', {id:'root', name:'Thư mục chính'}); 
    }
    if(!folders.find(f=>f.id===currentFolderId)) currentFolderId = folders[0].id;
    
    renderFolders(); renderFiles(); renderHistory(); 
}

function createFolder() { const n = prompt("Tên folder:"); if(n) { const f={id:Date.now().toString(), name:n}; folders.push(f); saveDB('folders', f); currentFolderId=f.id; renderFolders(); renderFiles(); } }
function renameFolder() { const c = folders.find(f=>f.id===currentFolderId); if(!c) return; const n = prompt("Đổi tên:", c.name); if(n){ c.name=n.trim(); saveDB('folders', c); renderFolders(); toast("Đã đổi tên"); } }
function deleteCurrentFolder() { if(confirm("Xóa folder này?")) { files.filter(f=>f.folderId===currentFolderId).forEach(f=>delDB('files',f.id)); delDB('folders', currentFolderId); files=files.filter(f=>f.folderId!==currentFolderId); folders=folders.filter(f=>f.id!==currentFolderId); if(folders.length===0){folders.push({id:'root',name:'Thư mục chính'});saveDB('folders',{id:'root',name:'Thư mục chính'});} currentFolderId=folders[0].id; renderFolders(); renderFiles(); switchView(currentView); toast("Đã xóa"); } }

function clearChecklist() { if(confirm("Xóa danh sách?")) { delete checklists[currentFolderId]; delDB('checklists', currentFolderId); renderChecklist(); toast("Đã xóa"); } }
function clearHistory() { if(confirm("Xóa nhật ký?")) { logs=[]; clearStore('history'); renderHistory(); toast("Đã dọn dẹp"); } }

// --- VIEWS & ACTIONS ---
function switchView(v) { 
    currentView=v; 
    Object.values(els.views).forEach(e=>e.classList.remove('active')); 
    els.views[v].classList.add('active'); 
    [els.btnViewFiles, els.btnViewChecklist, els.btnViewHistory].forEach(b=>b.classList.remove('active')); 
    if(v==='manager') els.btnViewFiles.classList.add('active'); 
    if(v==='checklist') els.btnViewChecklist.classList.add('active'); 
    if(v==='history') els.btnViewHistory.classList.add('active'); 
    if(v==='manager') renderFiles(); 
    if(v==='history') renderHistory(); 
    if(v==='checklist') renderChecklist(); 
}

// --- UTILS (Short) ---
function getAll(s) { return new Promise(r => db.transaction(s,'readonly').objectStore(s).getAll().onsuccess=e=>r(e.target.result||[])); }
function saveDB(s, i) { db.transaction(s,'readwrite').objectStore(s).put(i); }
function delDB(s, id) { db.transaction(s,'readwrite').objectStore(s).delete(id); }
function clearStore(s) { db.transaction(s, 'readwrite').objectStore(s).clear(); }
function toast(m) { els.toast.innerText = m; els.toast.classList.add('show'); setTimeout(()=>els.toast.classList.remove('show'), 2000); }
function getFilteredFiles() { let l = files.filter(f=>f.folderId===currentFolderId); if(currentView==='manager'){ const k=els.searchInput.value.toLowerCase(); if(k) l=l.filter(f=>f.name.toLowerCase().includes(k)); } return l.sort((a,b)=>getChapterNum(a.name)-getChapterNum(b.name)); }

// PREVIEW & OPS
window.openPreview = (id) => { 
    const f=files.find(x=>x.id===id); if(!f) return; previewFileId=id; 
    const list = getFilteredFiles(); const idx = list.findIndex(x=>x.id===id);
    els.previewTitle.innerText=f.name; els.previewDocHeader.innerText=f.headerInDoc; 
    let c=""; 
    if(f.segments) f.segments.forEach(s=>{ if(s.header!==f.headerInDoc) c+=`<h3 style="color:#2b6cb0;margin-top:20px;font-family:Calibri">${s.header}</h3>`; s.lines.forEach(l=>c+=`<p style="font-family:Calibri;font-size:16pt;margin-bottom:10px;text-align:justify">${l}</p>`); c+="<hr style='border:0;border-top:1px dashed #ccc;margin:20px 0'>"; }); 
    else c=f.rawContent.split('\n').map(l=>`<p>${l}</p>`).join(''); 
    els.previewBody.innerHTML=c; els.previewModal.classList.add('show'); 
};
window.closePreview = () => els.previewModal.classList.remove('show');
window.prevChapter = () => { const l=getFilteredFiles(); const i=l.findIndex(x=>x.id===previewFileId); if(i>0) openPreview(l[i-1].id); else toast("Đầu danh sách"); };
window.nextChapter = () => { const l=getFilteredFiles(); const i=l.findIndex(x=>x.id===previewFileId); if(i!==-1 && i<l.length-1) openPreview(l[i+1].id); else toast("Hết danh sách"); };
window.deleteOne = (id) => { if(confirm('Xóa file?')) { delDB('files', id); files=files.filter(f=>f.id!==id); renderFiles(); } };
function deleteBatch() { const s=getFilteredFiles().filter(f=>f.selected); if(confirm(`Xóa ${s.length} file?`)) { s.forEach(f=>delDB('files',f.id)); files=files.filter(f=>!f.selected || f.folderId!==currentFolderId); renderFiles(); } }
function downloadBatchZip() { const s=getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn"); const z=new JSZip(); s.forEach(f=>z.file(f.name, f.blob)); z.generateAsync({type:"blob"}).then(c=>saveAs(c,`Batch_${Date.now()}.zip`)); }
async function downloadBatchDirect() { const s=getFilteredFiles().filter(f=>f.selected); if(!s.length) return toast("Chưa chọn"); for(let f of s) { if(f.blob) { saveAs(f.blob, f.name); await new Promise(r=>setTimeout(r,300)); } } }

// BOOT
init();

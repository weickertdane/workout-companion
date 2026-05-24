const TRANSFER_UUID = "adaf0200-4669-6c65-5472-616e73666572";
const FS_SERVICE_UUID = 0xFEBB;
const CTS_SERVICE_UUID = 0x1805;

let transferCharacteristic = null;
let currentFileData = new Uint8Array(0);
let exercisesDb = [];
let workoutData = [];
let chartInstance = null;

// UI Elements
const btnConnect = document.getElementById('btn-connect');
const btnDownloadLogs = document.getElementById('btn-download-logs');
const btnExport = document.getElementById('btn-export-csv');
const statusText = document.getElementById('status-text');
const historyBody = document.getElementById('history-body');
const exerciseSelect = document.getElementById('exercise-select');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');

// Async Transfer State
let transferResolver = null;
let transferRejecter = null;

// Initialization
async function init() {
    try {
        const response = await fetch('exercises.json');
        exercisesDb = await response.json();
        
        // Populate select box
        exercisesDb.forEach(ex => {
            if (!ex.hidden) {
                const opt = document.createElement('option');
                opt.value = ex.id;
                opt.textContent = ex.name;
                exerciseSelect.appendChild(opt);
            }
        });
        
        exerciseSelect.addEventListener('change', updateChart);
    } catch (e) {
        console.error("Failed to load exercises.json", e);
        statusText.textContent = "Error: Failed to load exercises.json";
    }
}

// Chart Initialization
function updateChart() {
    const selectedId = parseInt(exerciseSelect.value);
    if (isNaN(selectedId)) return;
    
    // Group by date and find max weight
    const dailyMax = {};
    workoutData.forEach(set => {
        if (set.exerciseId === selectedId) {
            const dateStr = set.date.toLocaleDateString();
            if (!dailyMax[dateStr] || set.weight > dailyMax[dateStr]) {
                dailyMax[dateStr] = set.weight;
            }
        }
    });
    
    const labels = Object.keys(dailyMax).sort((a, b) => new Date(a) - new Date(b));
    const data = labels.map(l => dailyMax[l]);
    
    const ctx = document.getElementById('progressChart').getContext('2d');
    if (chartInstance) {
        chartInstance.destroy();
    }
    
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Max Weight (lbs)',
                data: data,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: false, ticks: { color: '#94a3b8' } },
                x: { ticks: { color: '#94a3b8' } }
            },
            plugins: {
                legend: { labels: { color: '#f8fafc' } }
            }
        }
    });
}

function updateHistoryTable() {
    historyBody.innerHTML = '';
    // Sort reverse chronological
    const sorted = [...workoutData].sort((a, b) => b.date - a.date);
    
    sorted.forEach(set => {
        const ex = exercisesDb.find(e => e.id === set.exerciseId);
        const name = ex ? ex.name : `Unknown (ID ${set.exerciseId})`;
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${set.date.toLocaleDateString()} ${set.date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
            <td>${name}</td>
            <td>${set.weight}</td>
            <td>${set.reps}</td>
        `;
        historyBody.appendChild(tr);
    });
}

// Web Bluetooth Connection
btnConnect.addEventListener('click', async () => {
    try {
        statusText.textContent = "Requesting Bluetooth Device...";
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [FS_SERVICE_UUID] }],
            optionalServices: [CTS_SERVICE_UUID]
        });
        
        statusText.textContent = "Connecting to GATT Server...";
        const server = await device.gatt.connect();
        
        // Time Sync
        try {
            const ctsService = await server.getPrimaryService(CTS_SERVICE_UUID);
            const timeChar = await ctsService.getCharacteristic(0x2a2b);
            const now = new Date();
            const buffer = new ArrayBuffer(10);
            const view = new DataView(buffer);
            view.setUint16(0, now.getFullYear(), true);
            view.setUint8(2, now.getMonth() + 1);
            view.setUint8(3, now.getDate());
            view.setUint8(4, now.getHours());
            view.setUint8(5, now.getMinutes());
            view.setUint8(6, now.getSeconds());
            view.setUint8(7, now.getDay() === 0 ? 7 : now.getDay());
            view.setUint8(8, 0); // fractions
            view.setUint8(9, 1); // adjust reason
            await timeChar.writeValue(buffer);
            console.log("Time synchronized via CTS.");
        } catch (e) {
            console.warn("Could not sync time.", e);
        }
        
        // FS Transfer
        statusText.textContent = "Setting up File Transfer Protocol...";
        const fsService = await server.getPrimaryService(FS_SERVICE_UUID);
        transferCharacteristic = await fsService.getCharacteristic(TRANSFER_UUID);
        
        await transferCharacteristic.startNotifications();
        transferCharacteristic.addEventListener('characteristicvaluechanged', handleTransferEvent);
        
        btnDownloadLogs.disabled = false;
        btnConnect.textContent = "Connected";
        btnConnect.disabled = true;
        
        // Automatically fetch workouts.csv
        await fetchFile('/user/workouts.csv', true);
        
    } catch (e) {
        console.error(e);
        statusText.textContent = `Connection failed: ${e.message}`;
    }
});

btnDownloadLogs.addEventListener('click', () => {
    fetchFile('/user/workout_app.log', false);
});

// Adafruit BLE FS Protocol
function handleTransferEvent(event) {
    const value = event.target.value;
    const dataView = new DataView(value.buffer);
    const command = dataView.getUint8(0);
    
    if (command === 0x11) { // Read Data Response
        const status = dataView.getInt8(1);
        if (status < 0) {
            if (transferRejecter) transferRejecter(`FS Error: ${status}`);
            return;
        }
        
        const offset = dataView.getUint32(4, true); // Little endian? Adafruit spec says little endian typically
        const totalSize = dataView.getUint32(8, true);
        const chunkSize = dataView.getUint32(12, true);
        
        // Extract chunk data
        const chunk = new Uint8Array(value.buffer, 16, chunkSize);
        
        // Append to current file buffer
        const newBuffer = new Uint8Array(currentFileData.length + chunk.length);
        newBuffer.set(currentFileData);
        newBuffer.set(chunk, currentFileData.length);
        currentFileData = newBuffer;
        
        // Update progress UI
        progressContainer.classList.remove('hidden');
        const percent = Math.floor((currentFileData.length / totalSize) * 100);
        progressFill.style.width = `${percent}%`;
        progressText.textContent = `${percent}%`;
        
        if (currentFileData.length < totalSize) {
            // Request next chunk (Command 0x12)
            const reqBuf = new ArrayBuffer(12);
            const reqView = new DataView(reqBuf);
            reqView.setUint8(0, 0x12);
            reqView.setUint8(1, 0x01); // status ok
            reqView.setUint32(4, currentFileData.length, true); // start reading at
            reqView.setUint32(8, 200, true); // bytes to read (MTU - header)
            transferCharacteristic.writeValue(reqBuf);
        } else {
            // Done
            setTimeout(() => progressContainer.classList.add('hidden'), 1000);
            if (transferResolver) {
                transferResolver(currentFileData);
            }
        }
    }
}

async function fetchFile(path, isWorkoutsCsv) {
    statusText.textContent = `Downloading ${path}...`;
    currentFileData = new Uint8Array(0);
    
    const pathBytes = new TextEncoder().encode(path);
    const buf = new ArrayBuffer(12 + pathBytes.length);
    const view = new DataView(buf);
    
    view.setUint8(0, 0x10); // Command: Read
    view.setUint16(2, pathBytes.length, true); // path length
    view.setUint32(4, 0, true); // start location
    view.setUint32(8, 200, true); // amount to read initially
    
    const outArr = new Uint8Array(buf);
    outArr.set(pathBytes, 12);
    
    try {
        const fileBytes = await new Promise((resolve, reject) => {
            transferResolver = resolve;
            transferRejecter = reject;
            transferCharacteristic.writeValue(buf).catch(reject);
        });
        
        const text = new TextDecoder().decode(fileBytes);
        
        if (isWorkoutsCsv) {
            parseCSV(text);
            statusText.textContent = `Successfully synced ${workoutData.length} sets.`;
        } else {
            // Download the log file locally to the user's computer
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = "workout_app.log";
            a.click();
            URL.revokeObjectURL(url);
            statusText.textContent = "Logs downloaded.";
        }
    } catch (e) {
        console.error(e);
        statusText.textContent = `File transfer failed: ${e}`;
    }
}

function parseCSV(csvText) {
    workoutData = [];
    const lines = csvText.split('\n');
    lines.forEach(line => {
        if (!line.trim()) return;
        const parts = line.split(',');
        if (parts.length >= 5) {
            workoutData.push({
                date: new Date(parseInt(parts[0]) * 1000), // Epoch to JS Date
                exerciseId: parseInt(parts[1]),
                setNumber: parseInt(parts[2]),
                weight: parseInt(parts[3]),
                reps: parseInt(parts[4])
            });
        }
    });
    
    updateHistoryTable();
    updateChart();
}

btnExport.addEventListener('click', () => {
    if (workoutData.length === 0) return;
    let csv = "Date,Time,Exercise,Weight(lbs),Reps\n";
    workoutData.forEach(set => {
        const ex = exercisesDb.find(e => e.id === set.exerciseId);
        const name = ex ? ex.name.replace(/,/g, '') : `Unknown`;
        csv += `${set.date.toLocaleDateString()},${set.date.toLocaleTimeString()},${name},${set.weight},${set.reps}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = "workout_history.csv";
    a.click();
});

// Run Init
init();

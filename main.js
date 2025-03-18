(function() {
  "use strict";
  
  // Variáveis globais
  let wsSocket = null;
  let deviceIds = [];
  let charts = {};
  let readings = {};
  let isRunning = false;
  let debugBuffer = [];
  let updateInterval = 250;
  let isRecording = false;
  let recordedData = [];
  let deviceHistory = {};
  let communicationLog = [];
  let isReadingInProgress = false;
  let transactionId = 0;
  let ipUsed = "";

  // Objeto para requisições pendentes
  const pendingRequests = {};

  // Elementos DOM
  const connectButton = document.getElementById('connect');
  const sendRequestButton = document.getElementById('sendRequest');
  const toggleRecordingButton = document.getElementById('toggleRecording');
  const recordingIndicator = document.getElementById('recording-indicator');
  const exportDataButton = document.getElementById('exportData');
  const clearDataButton = document.getElementById('clearData');
  const exportLogButton = document.getElementById('exportLog');
  const showHistoryButton = document.getElementById('showHistory');
  const exportHistoryButton = document.getElementById('exportHistory');
  const btnChangeBg = document.getElementById('btnChangeBg');
  const updateIntervalSelect = document.getElementById('updateInterval');

  // Funções auxiliares
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function changeBackground() {
    const color = prompt("Digite a cor desejada (ex.: lightblue, #ff0000, etc.):");
    if (color) document.body.style.backgroundColor = color;
  }

  // Event Listeners
  btnChangeBg.addEventListener('click', changeBackground);

  // Funções de log
  function logDebug(message) {
    const time = new Date().toLocaleTimeString();
    debugBuffer.push(`[${time}] ${message}`);
    if (debugBuffer.length > 100) { debugBuffer.shift(); }
    document.getElementById('debug').innerHTML = debugBuffer.join('<br>');
    document.getElementById('debug').scrollTop = document.getElementById('debug').scrollHeight;
    addToCommunicationLog("DEBUG", message);
  }

  function addToCommunicationLog(direction, message) {
    const timestamp = new Date().toISOString();
    communicationLog.push({ timestamp, direction, message });
  }

  // Funções Modbus
  function getNextTransactionId() {
    transactionId = (transactionId + 1) % 65536;
    return transactionId;
  }

  function buildModbusTCPRequest(deviceId, startAddress, quantity) {
    const tid = getNextTransactionId();
    const protocolId = 0x0000;
    const length = 6;
    const request = new Uint8Array(12);
    request[0] = (tid >> 8) & 0xFF;
    request[1] = tid & 0xFF;
    request[2] = (protocolId >> 8) & 0xFF;
    request[3] = protocolId & 0xFF;
    request[4] = (length >> 8) & 0xFF;
    request[5] = length & 0xFF;
    request[6] = deviceId;
    request[7] = 3;
    request[8] = (startAddress >> 8) & 0xFF;
    request[9] = startAddress & 0xFF;
    request[10] = (quantity >> 8) & 0xFF;
    request[11] = quantity & 0xFF;
    return request;
  }

  function parseModbusTCPResponse(response) {
    if (response.length < 9) return { error: "Resposta muito curta" };
    const tid = (response[0] << 8) | response[1];
    const protocolId = (response[2] << 8) | response[3];
    const length = (response[4] << 8) | response[5];
    const unitId = response[6];
    const functionCode = response[7];
    
    if (functionCode & 0x80) {
      const exceptionCode = response[8];
      return { error: `Erro Modbus: Função ${functionCode & 0x7F}, Código ${exceptionCode}` };
    }
    
    if (functionCode === 3) {
      const byteCount = response[8];
      if (response.length < 9 + byteCount) {
        return { error: "Dados incompletos" };
      }
      const data = response.slice(9, 9 + byteCount);
      return { transactionId: tid, unitId, functionCode, byteCount, data };
    }
    
    return { error: `Função não suportada: ${functionCode}` };
  }

  // Processamento de dados
  function parseRegisterValue(highByte, lowByte) {
    let value = (highByte << 8) | lowByte;
    if (value & 0x8000) { value -= 0x10000; }
    return value;
  }

  function processS15STHMQData(frame) {
    if (!frame || !frame.data || frame.data.length < 10) return null;
    const humidityRaw = parseRegisterValue(frame.data[0], frame.data[1]);
    const humidity = humidityRaw / 100;
    const tempCRaw = parseRegisterValue(frame.data[2], frame.data[3]);
    const temperatureC = tempCRaw * 0.05;
    const tempFRaw = parseRegisterValue(frame.data[4], frame.data[5]);
    const temperatureF = tempFRaw * 0.05;
    const dewCRaw = parseRegisterValue(frame.data[6], frame.data[7]);
    const dewPointC = dewCRaw / 100;
    const dewFRaw = parseRegisterValue(frame.data[8], frame.data[9]);
    const dewPointF = dewFRaw / 100;
    return { humidity, temperatureC, temperatureF, dewPointC, dewPointF };
  }

  function processS15CUMQData(frame) {
    if (!frame || !frame.data || frame.data.length < 2) return null;
    const raw = parseRegisterValue(frame.data[0], frame.data[1]);
    const voltage = raw / 1000;
    return { voltage };
  }

  // Implementação WebSocket
  function createEthernetSocket(ip) {
    return new Promise((resolve, reject) => {
      if (wsSocket && wsSocket.ws) {
        try {
          wsSocket.ws.close();
          wsSocket = null;
        } catch (e) {
          console.error("Erro ao fechar conexão anterior:", e);
        }
      }

      const ws = new WebSocket("ws://" + ip + ":8080/v1");
      ws.binaryType = "arraybuffer";
      
      let reconnectAttempts = 0;
      const MAX_RECONNECT_ATTEMPTS = 3;
      
      const socket = {
        ws: ws,
        isConnected: false,
        reconnect: async function() {
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            logDebug("Máximo de tentativas de reconexão atingido");
            return false;
          }
          reconnectAttempts++;
          try {
            this.ws.close();
            this.ws = new WebSocket("ws://" + ip + ":8080/v1");
            this.ws.binaryType = "arraybuffer";
            setupWebSocketHandlers(this.ws);
            return new Promise((res) => {
              this.ws.onopen = () => {
                this.isConnected = true;
                reconnectAttempts = 0;
                logDebug("Reconexão bem sucedida");
                res(true);
              };
            });
          } catch (e) {
            logDebug("Erro na tentativa de reconexão: " + e);
            return false;
          }
        },
        request: function(data) {
          return new Promise((resolveReq, rejectReq) => {
            if (!this.isConnected) {
              rejectReq(new Error("WebSocket não está conectado"));
              return;
            }
            const tid = (data[0] << 8) | data[1];
            pendingRequests[tid] = {
              resolve: resolveReq,
              reject: rejectReq,
              timeout: setTimeout(() => {
                delete pendingRequests[tid];
                rejectReq(new Error("Timeout aguardando resposta para TID " + tid));
              }, 5000)
            };
            try {
              this.ws.send(data);
            } catch (e) {
              delete pendingRequests[tid];
              rejectReq(new Error("Erro ao enviar dados: " + e.message));
            }
          });
        }
      };

      function setupWebSocketHandlers(ws) {
        ws.onopen = function() {
          logDebug("WebSocket conectado a " + ip);
          socket.isConnected = true;
          resolve(socket);
        };

        ws.onerror = function(event) {
          logDebug("WebSocket error: " + event);
          socket.isConnected = false;
          reject(new Error("Erro na conexão WebSocket"));
        };

        ws.onclose = async function() {
          socket.isConnected = false;
          logDebug("Conexão WebSocket fechada. Tentando reconectar...");
          if (isRunning) {
            await socket.reconnect();
          }
        };

        ws.onmessage = function(event) {
          const data = new Uint8Array(event.data);
          const tid = (data[0] << 8) | data[1];
          if (pendingRequests[tid]) {
            clearTimeout(pendingRequests[tid].timeout);
            pendingRequests[tid].resolve(data);
            delete pendingRequests[tid];
          } else {
            logDebug("Recebida resposta com TID desconhecido: " + tid);
          }
        };
      }

      setupWebSocketHandlers(ws);
    });
  }

  // Interface gráfica
  function createDeviceContainer(deviceId) {
    const container = document.createElement("div");
    container.className = "device-container";
    container.id = "device-" + deviceId;
    
    const header = document.createElement("div");
    header.className = "device-header";
    header.innerText = `Dispositivo ${deviceId}`;
    container.appendChild(header);
    
    const canvas = document.createElement("canvas");
    canvas.id = "chart-" + deviceId;
    canvas.className = "chart-canvas";
    container.appendChild(canvas);
    
    const readingsDiv = document.createElement("div");
    readingsDiv.id = "readings-" + deviceId;
    readingsDiv.className = "readings";
    container.appendChild(readingsDiv);
    
    document.getElementById("devices").appendChild(container);
    $("#" + canvas.id).draggable().resizable();
  }

  function initChartForDevice(deviceId) {
    const ctx = document.getElementById("chart-" + deviceId).getContext("2d");
    let datasets;
    
    if (deviceId === 4) {
      datasets = [
        { label: `Umidade (%RH) - Dispositivo ${deviceId}`, data: [], borderColor: 'rgba(54, 162, 235, 1)', backgroundColor: 'rgba(54, 162, 235, 0.2)' },
        { label: `Temp (°C) - Dispositivo ${deviceId}`, data: [], borderColor: 'rgba(255, 99, 132, 1)', backgroundColor: 'rgba(255, 99, 132, 0.2)' },
        { label: `Temp (°F) - Dispositivo ${deviceId}`, data: [], borderColor: 'rgba(255, 159, 64, 1)', backgroundColor: 'rgba(255, 159, 64, 0.2)' },
        { label: `D.P. (°C) - Dispositivo ${deviceId}`, data: [], borderColor: 'rgba(75, 192, 192, 1)', backgroundColor: 'rgba(75, 192, 192, 0.2)' },
        { label: `D.P. (°F) - Dispositivo ${deviceId}`, data: [], borderColor: 'rgba(153, 102, 255, 1)', backgroundColor: 'rgba(153, 102, 255, 0.2)' }
      ];
    } else {
      datasets = [
        { label: `Tensão (VDC) - Dispositivo ${deviceId}`, data: [], borderColor: 'rgba(54, 162, 235, 1)', backgroundColor: 'rgba(54, 162, 235, 0.2)' }
      ];
    }

    const chartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 50 },
      scales: {
        x: {
          type: 'category',
          display: true,
          title: {
            display: true,
            text: 'Tempo'
          }
        },
        y: {
          display: true,
          title: {
            display: true,
            text: deviceId === 4 ? 'Valores' : 'Tensão (V)'
          }
        }
      }
    };

    if (deviceId !== 4) {
      chartOptions.scales.y.min = 0;
      chartOptions.scales.y.max = 10;
    }

    const chartConfig = {
      type: 'line',
      data: { labels: [], datasets: datasets },
      options: chartOptions
    };

    charts[deviceId] = new Chart(ctx, chartConfig);
  }

  // Funções de atualização
  function getMovingAverage(deviceId, fieldName, windowSize = 5) {
    const data = readings[deviceId] || [];
    if (data.length === 0) return 0;
    const windowData = data.slice(-windowSize);
    const sum = windowData.reduce((acc, reading) => acc + (reading[fieldName] || 0), 0);
    return sum / windowData.length;
  }

  function updateChartForDevice(deviceId, sensorData) {
    const chart = charts[deviceId];
    if (!chart) return;

    const now = new Date();
    const timeLabel = now.toLocaleTimeString();
    chart.data.labels.push(timeLabel);

    if (deviceId === 4) {
      chart.data.datasets[0].data.push(getMovingAverage(deviceId, 'humidity'));
      chart.data.datasets[1].data.push(getMovingAverage(deviceId, 'temperatureC'));
      chart.data.datasets[2].data.push(getMovingAverage(deviceId, 'temperatureF'));
      chart.data.datasets[3].data.push(getMovingAverage(deviceId, 'dewPointC'));
      chart.data.datasets[4].data.push(getMovingAverage(deviceId, 'dewPointF'));
    } else {
      chart.data.datasets[0].data.push(getMovingAverage(deviceId, 'voltage'));
    }

    if (chart.data.labels.length > 500) {
      chart.data.labels.shift();
      chart.data.datasets.forEach(dataset => dataset.data.shift());
    }

    chart.update();
  }

  function updateDisplayForDevice(deviceId) {
    const readingsDiv = document.getElementById("readings-" + deviceId);
    if (!readingsDiv) return;
    
    readingsDiv.innerHTML = "";
    const deviceReadings = readings[deviceId] || [];
    const displayReadings = deviceReadings.slice(-3);
    
    displayReadings.forEach((reading, index) => {
      const div = document.createElement("div");
      div.className = "reading";
      if (deviceId === 4) {
        div.innerHTML = `
          <strong>Leitura ${index + 1}:</strong><br>
          Umidade: ${reading.humidity.toFixed(2)}%RH<br>
          Temperatura: ${reading.temperatureC.toFixed(2)}°C / ${reading.temperatureF.toFixed(2)}°F<br>
          Ponto de Orvalho: ${reading.dewPointC.toFixed(2)}°C / ${reading.dewPointF.toFixed(2)}°F
        `;
      } else {
        div.innerHTML = `
          <strong>Leitura ${index + 1}:</strong><br>
          Tensão: ${reading.voltage.toFixed(3)}V
        `;
      }
      readingsDiv.appendChild(div);
    });
  }

  // Loop principal de requisições
  async function sendRequestsForAllDevices() {
    while (isRunning) {
      if (isReadingInProgress) {
        await sleep(50);
        continue;
      }

      isReadingInProgress = true;
      for (const deviceId of deviceIds) {
        try {
          const request = buildModbusTCPRequest(deviceId, 0, deviceId === 4 ? 5 : 1);
          const response = await wsSocket.request(request);
          const frame = parseModbusTCPResponse(response);
          
          if (frame.error) {
            logDebug(`Erro na leitura do dispositivo ${deviceId}: ${frame.error}`);
            continue;
          }

          const sensorData = deviceId === 4 ? 
            processS15STHMQData(frame) : 
            processS15CUMQData(frame);

          if (sensorData) {
            if (!readings[deviceId]) readings[deviceId] = [];
            readings[deviceId].push(sensorData);
            
            if (isRecording) {
              recordedData.push({
                timestamp: new Date().toISOString(),
                deviceId,
                ...sensorData
              });
            }

            updateChartForDevice(deviceId, sensorData);
            updateDisplayForDevice(deviceId);
          }
        } catch (error) {
          logDebug(`Erro ao ler dispositivo ${deviceId}: ${error.message}`);
        }
      }
      isReadingInProgress = false;
      await sleep(updateInterval);
    }
  }

  // Event Listeners
  connectButton.addEventListener('click', async () => {
    try {
      connectButton.disabled = true;
      
      deviceIds = document.getElementById('deviceIds').value
        .split(",")
        .map(s => parseInt(s.trim()))
        .filter(id => !isNaN(id));
        
      if (deviceIds.length === 0) {
        alert("Insira pelo menos um ID válido.");
        connectButton.disabled = false;
        return;
      }

      const ipField = document.getElementById('ipAddress');
      ipUsed = ipField.value.trim() || "192.168.16.200";
      
      document.getElementById("devices").innerHTML = "";
      for (let id of deviceIds) {
        createDeviceContainer(id);
        initChartForDevice(id);
        readings[id] = [];
      }

      wsSocket = await createEthernetSocket(ipUsed);
      
      document.getElementById('messages').innerHTML = 
        `<div>Conexão estabelecida com o conversor em ${ipUsed}!</div>`;
      sendRequestButton.disabled = false;
      toggleRecordingButton.disabled = false;
      isRunning = true;
      sendRequestsForAllDevices();
      
    } catch (error) {
      document.getElementById('messages').innerHTML = 
        `<div style="color:red;">Erro ao conectar: ${error.message}</div>`;
      console.error("Erro ao conectar:", error);
    } finally {
      connectButton.disabled = false;
    }
  });

  toggleRecordingButton.addEventListener('click', () => {
    isRecording = !isRecording;
    toggleRecordingButton.textContent = isRecording ? "Parar Gravação" : "Iniciar Gravação";
    toggleRecordingButton.classList.toggle("recording");
    recordingIndicator.style.display = isRecording ? "inline" : "none";
    if (isRecording) {
      recordedData = [];
    }
  });

  exportDataButton.addEventListener('click', () => {
    if (recordedData.length === 0) {
      alert("Não há dados para exportar!");
      return;
    }

    const csv = [
      "Timestamp,DeviceID,Humidity,TemperatureC,TemperatureF,DewPointC,DewPointF,Voltage"
    ];

    recordedData.forEach(record => {
      csv.push(`${record.timestamp},${record.deviceId},${record.humidity || ''},${record.temperatureC || ''},${record.temperatureF || ''},${record.dewPointC || ''},${record.dewPointF || ''},${record.voltage || ''}`);
    });

    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `microseal_data_${new Date().toISOString()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  });

  clearDataButton.addEventListener('click', () => {
    if (confirm("Deseja realmente limpar todos os dados?")) {
      recordedData = [];
      readings = {};
      deviceIds.forEach(id => {
        readings[id] = [];
        if (charts[id]) {
          charts[id].data.labels = [];
          charts[id].data.datasets.forEach(dataset => dataset.data = []);
          charts[id].update();
        }
        updateDisplayForDevice(id);
      });
    }
  });

  updateIntervalSelect.addEventListener('change', (e) => {
    updateInterval = parseInt(e.target.value);
  });

})();
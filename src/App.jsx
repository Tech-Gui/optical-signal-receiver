import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const MAX_BIT_BUFFER = 128

function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const frameRequestRef = useRef(null)
  const isRunningRef = useRef(false)
  const brightnessRef = useRef(0)
  const thresholdRef = useRef(140)

  // Edge decoding references
  const lastStateRef = useRef(null)
  const lastTransitionTimeRef = useRef(0)
  const accumulatedBitsRef = useRef('')

  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState('')
  const [brightness, setBrightness] = useState(0)
  const [bits, setBits] = useState('')
  const [threshold, setThreshold] = useState(thresholdRef.current)
  const [sampleMs, setSampleMs] = useState(100)
  const [cameraInfo, setCameraInfo] = useState(null)
  const [messages, setMessages] = useState([])
  const [cameraOverride, setCameraOverride] = useState('auto')
  const [isRecalibrating, setIsRecalibrating] = useState(false)
  
  const recalibratingRef = useRef(false)
  const recalStatsRef = useRef({ min: 255, max: 0 })

  const facingPreference = useMemo(() => {
    if (cameraOverride !== 'auto') return cameraOverride
    if (typeof navigator === 'undefined') return 'user'
    const ua = navigator.userAgent.toLowerCase()
    const isMobile = /iphone|ipad|ipod|android/.test(ua)
    return isMobile ? 'environment' : 'user'
  }, [cameraOverride])

  useEffect(() => {
    brightnessRef.current = brightness
  }, [brightness])

  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])

  useEffect(() => {
    return () => stopCapture()
  }, [])

  const waitForMetadata = (video) =>
    new Promise((resolve) => {
      if (!video) {
        resolve()
        return
      }
      if (video.readyState >= 1) {
        resolve()
        return
      }
      const handler = () => {
        video.removeEventListener('loadedmetadata', handler)
        resolve()
      }
      video.addEventListener('loadedmetadata', handler)
    })

  const cancelFrameLoop = () => {
    const video = videoRef.current
    if (typeof video?.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(frameRequestRef.current ?? 0)
    }
    cancelAnimationFrame(frameRequestRef.current ?? 0)
    frameRequestRef.current = null
  }

  const beginAnalysis = () => {
    isRunningRef.current = true
    setIsRunning(true)
    processFrame()
    scheduleFrameLoop()
    startSampler()
  }

  const startCapture = async () => {
    setError('')
    await stopCapture()

    if (!navigator?.mediaDevices?.getUserMedia) {
      setError('Camera API not available in this browser.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facingPreference },
          width: { ideal: 4096 },
          height: { ideal: 2160 },
          frameRate: { ideal: 60 },
        },
      })

      const video = videoRef.current
      if (!video) {
        return
      }
      video.srcObject = stream
      await video.play()
      await waitForMetadata(video)

      const [track] = stream.getVideoTracks()
      const settings = track?.getSettings ? track.getSettings() : null
      setCameraInfo({
        width: settings?.width ?? (video.videoWidth || null),
        height: settings?.height ?? (video.videoHeight || null),
        frameRate: settings?.frameRate ?? null,
      })
      beginAnalysis()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Unable to open camera')
    }
  }

  const stopCapture = async () => {
    isRunningRef.current = false
    setIsRunning(false)
    cancelFrameLoop()
    lastStateRef.current = null; // Reset decoder
    lastTransitionTimeRef.current = 0;
    accumulatedBitsRef.current = '';
    const video = videoRef.current
    if (video?.srcObject) {
      const tracks = video.srcObject.getTracks?.() ?? []
      tracks.forEach((track) => track.stop())
      video.srcObject = null
    }
    if (video) {
      video.pause?.()
      video.src = ''
      video.load?.()
    }
  }

  const processFrame = () => {
    if (!isRunningRef.current) {
      return
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      return
    }

    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      return
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      return
    }

    const targetWidth = 320
    const targetHeight = Math.max(
      1,
      Math.round((video.videoHeight / video.videoWidth) * targetWidth),
    )

    canvas.width = targetWidth
    canvas.height = targetHeight
    ctx.drawImage(video, 0, 0, targetWidth, targetHeight)

    const roiSize = 40
    const startX = Math.max(Math.round(targetWidth / 2 - roiSize / 2), 0)
    const startY = Math.max(Math.round(targetHeight / 2 - roiSize / 2), 0)

    const image = ctx.getImageData(startX, startY, roiSize, roiSize)
    let total = 0
    const pixels = image.data.length / 4
    for (let i = 0; i < image.data.length; i += 4) {
      const r = image.data[i]
      const g = image.data[i + 1]
      const b = image.data[i + 2]
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    const avg = pixels ? total / pixels : 0
    const currentBrightness = Number(avg.toFixed(1))
    setBrightness(currentBrightness)

    if (recalibratingRef.current) {
      if (currentBrightness < recalStatsRef.current.min) recalStatsRef.current.min = currentBrightness
      if (currentBrightness > recalStatsRef.current.max) recalStatsRef.current.max = currentBrightness
    }

    // --- Edge-based Run-Length Decoder ---
    // Instead of randomly sampling with setInterval, we record the exact 
    // duration between transitions (LOW->HIGH or HIGH->LOW) to calculate the bits emitted.
    const now = performance.now()
    if (!lastTransitionTimeRef.current) lastTransitionTimeRef.current = now
    
    // Determine the state for this frame based on the current threshold
    const newState = currentBrightness >= thresholdRef.current ? '1' : '0'

    if (lastStateRef.current !== null && newState !== lastStateRef.current) {
      const duration = now - lastTransitionTimeRef.current
      // Dividing duration by sampleMs gives us how many "beats" happened. Math.round corrects minor jitter.
      const numBits = Math.round(duration / sampleMs) 
      
      let bitStr = ''
      for (let i = 0; i < numBits; i++) bitStr += lastStateRef.current
      
      if (bitStr.length > 0) {
        accumulatedBitsRef.current += bitStr
        
        // Cap max length to save memory natively
        if (accumulatedBitsRef.current.length > MAX_BIT_BUFFER * 2) {
           accumulatedBitsRef.current = accumulatedBitsRef.current.slice(-MAX_BIT_BUFFER * 2)
        }
        
        setBits(accumulatedBitsRef.current.length > MAX_BIT_BUFFER 
            ? accumulatedBitsRef.current.slice(-MAX_BIT_BUFFER) 
            : accumulatedBitsRef.current)
            
        // Look for STX and ETX to Decode directly from the string
        let nextStr = accumulatedBitsRef.current
        const stx = '00000010'
        const etx = '00000011'
        let stxIndex = nextStr.indexOf(stx)
        let parsedAny = false
        
        while (stxIndex !== -1) {
          let etxIndex = nextStr.indexOf(etx, stxIndex + 8)
          if (etxIndex !== -1) {
            const payload = nextStr.slice(stxIndex + 8, etxIndex)
            let asciiStr = ''
            for (let i = 0; i < payload.length; i += 8) {
              const byteStr = payload.slice(i, i + 8)
              if (byteStr.length === 8) {
                asciiStr += String.fromCharCode(parseInt(byteStr, 2))
              }
            }
            if (asciiStr) {
              setMessages(m => [...m, asciiStr])
            }
            // Cut off parsed contents out of buffer
            nextStr = nextStr.slice(etxIndex + 8)
            stxIndex = nextStr.indexOf(stx)
            parsedAny = true
          } else {
            break
          }
        }
        
        if (parsedAny) {
            accumulatedBitsRef.current = nextStr
            setBits(accumulatedBitsRef.current.length > MAX_BIT_BUFFER 
                ? accumulatedBitsRef.current.slice(-MAX_BIT_BUFFER) 
                : accumulatedBitsRef.current)
        }
      }
      
      lastTransitionTimeRef.current = now
    }
    
    lastStateRef.current = newState

    ctx.strokeStyle = '#00ff80'
    ctx.lineWidth = 1
    ctx.strokeRect(startX, startY, roiSize, roiSize)
  }

  const scheduleFrameLoop = () => {
    if (!isRunningRef.current) {
      return
    }
    const video = videoRef.current
    if (!video) {
      return
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      frameRequestRef.current = video.requestVideoFrameCallback(() => {
        processFrame()
        scheduleFrameLoop()
      })
    } else {
      frameRequestRef.current = requestAnimationFrame(() => {
        processFrame()
        scheduleFrameLoop()
      })
    }
  }

  const startSampler = () => {
    // Replaced by edge-decoder inside processFrame
  }

  useEffect(() => {
    // sampleMs logic handled in processFrame seamlessly
  }, [sampleMs, isRunning])

  const clearBits = () => {
    setBits('')
    accumulatedBitsRef.current = ''
  }
  
  const startRecalibration = () => {
    setIsRecalibrating(true)
    recalibratingRef.current = true
    recalStatsRef.current = { min: 255, max: 0 }
    
    setTimeout(() => {
      const { min, max } = recalStatsRef.current
      const newThreshold = Math.round((min + max) / 2)
      if (!isNaN(newThreshold) && isFinite(newThreshold)) {
        setThreshold(newThreshold)
      }
      setIsRecalibrating(false)
      recalibratingRef.current = false
    }, 3000)
  }

  const handleThresholdChange = (event) => {
    setThreshold(event.target.valueAsNumber ?? Number(event.target.value))
  }

  const handleSampleMsChange = (event) => {
    setSampleMs(event.target.valueAsNumber ?? Number(event.target.value))
  }

  const activeBit = brightness >= threshold ? '1' : '0'
  const sourceLabel = isRunning ? 'Live camera' : 'Idle'

  return (
    <div className="app">
      <header>
        <h1>Optical Receiver Playground</h1>
        <p>
          Requests the back camera on phones and the front camera on desktops,
          then samples brightness to decode on/off keyed laser pulses.
        </p>
      </header>

      <section className="controls">
        <button onClick={isRunning ? stopCapture : startCapture}>
          {isRunning ? 'Stop capture' : 'Start capture'}
        </button>
        <button onClick={startRecalibration} disabled={!isRunning || isRecalibrating}>
          {isRecalibrating ? 'Recalibrating (3s)...' : 'Recalibrate'}
        </button>
        <label>
          Camera:
          <select value={cameraOverride} onChange={(e) => {
            setCameraOverride(e.target.value)
            if (isRunning) stopCapture()
          }}>
            <option value="auto">Auto</option>
            <option value="user">Front</option>
            <option value="environment">Back</option>
          </select>
        </label>
        <label>
          Threshold ({threshold})
          <input
            type="range"
            min="0"
            max="255"
            value={threshold}
            onInput={handleThresholdChange}
            onChange={handleThresholdChange}
          />
        </label>
        <label>
          Sample interval ({sampleMs}ms)
          <input
            type="range"
            min="30"
            max="500"
            step="10"
            value={sampleMs}
            onInput={handleSampleMsChange}
            onChange={handleSampleMsChange}
          />
        </label>
        <button onClick={clearBits} disabled={!bits}>
          Clear bits
        </button>
      </section>

      {error ? <p className="error">⚠️ {error}</p> : null}

      <section className="display">
        <div className="video-panel">
          <video ref={videoRef} playsInline autoPlay muted />
          <canvas ref={canvasRef} />
        </div>
        <div className="stats">
          <div>
            <span className="label">Facing preference</span>
            <span className="value">{facingPreference}</span>
          </div>
          <div>
            <span className="label">Source</span>
            <span className="value">{sourceLabel}</span>
          </div>
          <div>
            <span className="label">Avg brightness</span>
            <span className="value">{brightness.toFixed(1)}</span>
          </div>
          <div>
            <span className="label">Current bit</span>
            <span className={`bit bit-${activeBit}`}>{activeBit}</span>
          </div>
          <div>
            <span className="label">Reported resolution</span>
            <span className="value">
              {cameraInfo?.width ?? '—'} × {cameraInfo?.height ?? '—'}
            </span>
          </div>
          <div>
            <span className="label">Frame rate</span>
            <span className="value">
              {cameraInfo?.frameRate ? `${cameraInfo.frameRate} fps` : '—'}
            </span>
          </div>
        </div>
      </section>

      <section className="bits">
        <h2>Decoded Messages</h2>
        <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '8px', marginBottom: '8px', color: '#38bdf8', minHeight: '40px', wordWrap: 'break-word' }}>
          {messages.length === 0 ? (
            <span style={{color: '#94a3b8'}}>No messages received yet...</span>
          ) : (
            messages.map((m, i) => <div key={i}>[{new Date().toLocaleTimeString()}] {m}</div>)
          )}
        </div>
        <button onClick={() => setMessages([])} disabled={!messages.length} style={{marginBottom: '20px'}}>Clear messages</button>

        <h2>Bit stream (latest {MAX_BIT_BUFFER})</h2>
        <code>{bits || '—'}</code>
      </section>

      <section className="notes">
        <h2>Notes on “full resolution”</h2>
        <ul>
          <li>
            The app requests 4K (4096×2160) video with 60&nbsp;fps, but the
            browser ultimately negotiates what the camera and OS allow. Check the
            reported resolution above to confirm what you actually get.
          </li>
          <li>
            iOS Safari currently caps WebRTC camera streams to ~1080p, and many
            Android browsers will downscale to match performance requirements,
            so true sensor resolution is rarely exposed.
          </li>
          <li>
            For analysis we downscale frames to 320&nbsp;px wide on the canvas to
            keep CPU use low. You can raise that value in{' '}
            <code>src/App.jsx</code> if you need more detail.
          </li>
        </ul>
      </section>
    </div>
  )
}

export default App

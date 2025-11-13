import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const MAX_BIT_BUFFER = 128

function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const sampleTimerRef = useRef(null)
  const isRunningRef = useRef(false)
  const objectUrlRef = useRef('')
  const brightnessRef = useRef(0)
  const thresholdRef = useRef(140)

  const [isRunning, setIsRunning] = useState(false)
  const [sourceType, setSourceType] = useState('idle')
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [brightness, setBrightness] = useState(0)
  const [bits, setBits] = useState('')
  const [threshold, setThreshold] = useState(thresholdRef.current)
  const [sampleMs, setSampleMs] = useState(100)
  const [cameraInfo, setCameraInfo] = useState(null)

  const facingPreference = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return 'user'
    }
    const ua = navigator.userAgent.toLowerCase()
    const isMobile = /iphone|ipad|ipod|android/.test(ua)
    return isMobile ? 'environment' : 'user'
  }, [])

  useEffect(() => {
    brightnessRef.current = brightness
  }, [brightness])

  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])

  useEffect(() => {
    return () => stopCapture()
  }, [])

  const cleanupObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = ''
    }
  }

  const beginAnalysis = () => {
    isRunningRef.current = true
    setIsRunning(true)
    tickAnalysis()
    startSampler()
  }

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

      const [track] = stream.getVideoTracks()
      setCameraInfo(track?.getSettings() ?? null)
      setSourceType('camera')
      setFileName('')
      beginAnalysis()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Unable to open camera')
    }
  }

  const stopCapture = async () => {
    isRunningRef.current = false
    setIsRunning(false)
    setSourceType('idle')
    cancelAnimationFrame(animationRef.current ?? 0)
    clearInterval(sampleTimerRef.current ?? 0)
    cleanupObjectUrl()
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
    setFileName('')
  }

  const loadVideoFile = async (file) => {
    if (!file) {
      return
    }
    setError('')
    await stopCapture()

    const video = videoRef.current
    if (!video) {
      return
    }

    cleanupObjectUrl()
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url

    video.srcObject = null
    video.src = url
    video.loop = true
    video.muted = true

    try {
      await waitForMetadata(video)
      await video.play()
    } catch (err) {
      console.error(err)
      setError(
        err instanceof Error ? err.message : 'Unable to play the selected file',
      )
      return
    }

    setCameraInfo({
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      frameRate: null,
    })
    setFileName(file.name)
    setSourceType('file')
    beginAnalysis()
  }

  const tickAnalysis = () => {
    if (!isRunningRef.current) {
      return
    }

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) {
      return
    }

    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      animationRef.current = requestAnimationFrame(tickAnalysis)
      return
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      animationRef.current = requestAnimationFrame(tickAnalysis)
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
    setBrightness(Number(avg.toFixed(1)))

    ctx.strokeStyle = '#00ff80'
    ctx.lineWidth = 1
    ctx.strokeRect(startX, startY, roiSize, roiSize)

    animationRef.current = requestAnimationFrame(tickAnalysis)
  }

  const startSampler = () => {
    clearInterval(sampleTimerRef.current ?? 0)
    sampleTimerRef.current = setInterval(() => {
      if (!isRunningRef.current) {
        return
      }
      const nextBit = brightnessRef.current >= thresholdRef.current ? '1' : '0'
      setBits((prev) => {
        const next = `${prev}${nextBit}`
        return next.length > MAX_BIT_BUFFER ? next.slice(-MAX_BIT_BUFFER) : next
      })
    }, sampleMs)
  }

  useEffect(() => {
    if (isRunning) {
      startSampler()
    }
    return () => clearInterval(sampleTimerRef.current ?? 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleMs, isRunning])

  const clearBits = () => setBits('')

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }
    await loadVideoFile(file)
    event.target.value = ''
  }

  const activeBit = brightness >= threshold ? '1' : '0'
  const sourceLabel =
    sourceType === 'camera'
      ? 'Live camera'
      : sourceType === 'file'
        ? 'Video upload'
        : 'Idle'

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
        <label className="file-upload">
          Analyze video file
          <input
            type="file"
            accept="video/*"
            onChange={handleFileUpload}
          />
        </label>
        {fileName ? (
          <span className="file-name" title={fileName}>
            {fileName}
          </span>
        ) : null}
        <label>
          Threshold ({threshold})
          <input
            type="range"
            min="0"
            max="255"
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
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
            onChange={(event) => setSampleMs(Number(event.target.value))}
          />
        </label>
        <button onClick={clearBits} disabled={!bits}>
          Clear bits
        </button>
      </section>

      {error ? <p className="error">⚠️ {error}</p> : null}

      <section className="display">
        <div className="video-panel">
          <video
            ref={videoRef}
            playsInline
            autoPlay
            muted
            controls={sourceType === 'file'}
          />
          <canvas ref={canvasRef} />
        </div>
        <div className="stats">
          <div>
            <span className="label">Facing preference</span>
            <span>{facingPreference}</span>
          </div>
          <div>
            <span className="label">Source</span>
            <span>{sourceLabel}</span>
          </div>
          <div>
            <span className="label">Avg brightness</span>
            <span>{brightness.toFixed(1)}</span>
          </div>
          <div>
            <span className="label">Current bit</span>
            <span className={`bit bit-${activeBit}`}>{activeBit}</span>
          </div>
          {cameraInfo ? (
            <>
              <div>
                <span className="label">Reported resolution</span>
                <span>
                  {cameraInfo.width ?? '?'} × {cameraInfo.height ?? '?'}
                </span>
              </div>
              <div>
                <span className="label">Frame rate</span>
                <span>{cameraInfo.frameRate ?? '?'} fps</span>
              </div>
            </>
          ) : null}
          {sourceType === 'file' && fileName ? (
            <div>
              <span className="label">File</span>
              <span title={fileName}>{fileName}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="bits">
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
            You can also upload a recorded clip (ideal for repeatable tests) via
            the control above; the analysis pipeline is the same, so you can
            compare live vs recorded sessions frame by frame.
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

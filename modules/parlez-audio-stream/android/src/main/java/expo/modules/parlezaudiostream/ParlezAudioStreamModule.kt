package expo.modules.parlezaudiostream

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread
import kotlin.math.sqrt

/**
 * Captures the microphone as raw PCM16 / 16 kHz / mono and emits base64 chunks
 * (~100 ms each) on the `onAudioChunk` event, along with an RMS amplitude so the
 * JS waveform keeps animating without the speech recognizer's volume events.
 *
 * Uses the VOICE_COMMUNICATION source (not VOICE_RECOGNITION) so the platform
 * applies acoustic echo cancellation: the mic now opens the instant Camille
 * finishes, so without AEC it would re-capture her TTS coming out of the speaker
 * and transcribe it as a phantom user turn. We also attach AcousticEchoCanceler +
 * NoiseSuppressor explicitly where available.
 */
class ParlezAudioStreamModule : Module() {
  private val sampleRate = 16_000
  private val channelConfig = AudioFormat.CHANNEL_IN_MONO
  private val audioEncoding = AudioFormat.ENCODING_PCM_16BIT
  /** 1600 samples = 100 ms at 16 kHz. */
  private val chunkSamples = 1600

  @Volatile private var recording = false
  private var recorder: AudioRecord? = null
  private var worker: Thread? = null
  private var echoCanceler: AcousticEchoCanceler? = null
  private var noiseSuppressor: NoiseSuppressor? = null

  override fun definition() = ModuleDefinition {
    Name("ParlezAudioStream")

    Events("onAudioChunk")

    AsyncFunction("start") {
      startCapture()
    }

    AsyncFunction("stop") {
      stopCapture()
    }

    OnDestroy {
      stopCapture()
    }
  }

  private fun startCapture() {
    if (recording) return

    val minBuf = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioEncoding)
    if (minBuf <= 0) {
      throw IllegalStateException("AudioRecord buffer size unavailable")
    }
    val bufferSize = maxOf(minBuf, chunkSamples * 2 * 4)

    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      sampleRate,
      channelConfig,
      audioEncoding,
      bufferSize,
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) {
      rec.release()
      throw IllegalStateException("AudioRecord failed to initialize")
    }

    // Cancel Camille's speaker output from the mic input (the mic opens right as
    // she finishes). Best-effort — not all devices expose these effects.
    val sessionId = rec.audioSessionId
    if (AcousticEchoCanceler.isAvailable()) {
      echoCanceler = AcousticEchoCanceler.create(sessionId)?.apply { enabled = true }
    }
    if (NoiseSuppressor.isAvailable()) {
      noiseSuppressor = NoiseSuppressor.create(sessionId)?.apply { enabled = true }
    }

    recorder = rec
    recording = true
    rec.startRecording()

    worker = thread(start = true, name = "parlez-audio-capture") {
      val samples = ShortArray(chunkSamples)
      while (recording) {
        val read = rec.read(samples, 0, samples.size)
        if (read <= 0) continue

        val bytes = ByteArray(read * 2)
        var sumSquares = 0.0
        for (i in 0 until read) {
          val s = samples[i].toInt()
          bytes[i * 2] = (s and 0xff).toByte()
          bytes[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
          sumSquares += (s.toDouble() * s.toDouble())
        }
        val rms = sqrt(sumSquares / read) / 32768.0
        val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)

        sendEvent(
          "onAudioChunk",
          mapOf(
            "base64" to base64,
            "rms" to rms,
          ),
        )
      }
    }
  }

  private fun stopCapture() {
    recording = false
    try {
      worker?.join(400)
    } catch (_: InterruptedException) {
    }
    worker = null
    echoCanceler?.release()
    echoCanceler = null
    noiseSuppressor?.release()
    noiseSuppressor = null
    recorder?.let {
      try {
        it.stop()
      } catch (_: IllegalStateException) {
      }
      it.release()
    }
    recorder = null
  }
}

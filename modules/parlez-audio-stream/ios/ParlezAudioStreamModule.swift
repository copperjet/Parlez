import ExpoModulesCore

/// iOS stub for the Parlez PCM mic-streaming module.
///
/// Streaming capture is not implemented on iOS yet (Tier-2 is Android-first), so
/// `start()` throws and the JS layer falls back to the device speech recognizer.
/// The module still registers the same surface so the native bridge resolves.
internal final class UnsupportedException: Exception {
  override var reason: String {
    "Parlez audio streaming capture is not supported on iOS yet"
  }
}

public class ParlezAudioStreamModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ParlezAudioStream")

    Events("onAudioChunk")

    AsyncFunction("start") {
      throw UnsupportedException()
    }

    AsyncFunction("stop") {
      // no-op
    }
  }
}

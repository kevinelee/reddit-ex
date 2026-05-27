(function () {
  'use strict';

  function getVideo() {
    return document.querySelector('video');
  }

  function controlVideo(key, shiftKey) {
    const video = getVideo();
    if (!video) return;

    switch (key) {
      case ' ': case 'k': case 'K':
        video.paused ? video.play() : video.pause(); break;
      case 'f': case 'F':
        if (!document.fullscreenElement) {
          (video.closest('[class*="player"]') || video).requestFullscreen?.();
        } else {
          document.exitFullscreen();
        }
        break;
      case 'm': case 'M':
        video.muted = !video.muted; break;
      case 'ArrowLeft':
        video.currentTime = Math.max(0, video.currentTime - (shiftKey ? 10 : 5)); break;
      case 'ArrowRight':
        video.currentTime = Math.min(video.duration, video.currentTime + (shiftKey ? 10 : 5)); break;
      case 'ArrowUp':
        video.volume = Math.min(1, video.volume + 0.1); break;
      case 'ArrowDown':
        video.volume = Math.max(0, video.volume - 0.1); break;
      case 'j': case 'J':
        video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'l': case 'L':
        video.currentTime = Math.min(video.duration, video.currentTime + 10); break;
      case ',':
        video.currentTime = Math.max(0, video.currentTime - 1 / 30); break;
      case '.':
        video.currentTime = Math.min(video.duration, video.currentTime + 1 / 30); break;
      default:
        if (key >= '0' && key <= '9') {
          video.currentTime = video.duration * (parseInt(key) / 10);
        }
    }
  }

  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'rr-video-key') {
      controlVideo(e.data.key, e.data.shiftKey);
    }
  });
})();

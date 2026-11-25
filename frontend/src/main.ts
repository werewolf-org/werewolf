import './index.css'
import { render } from './router'
import { socketService } from './socket.service'

// Initialize socket connection (this triggers the Render cold-start if needed)
socketService.connect()

window.addEventListener('hashchange', () => {
  render()
})

document.addEventListener('DOMContentLoaded', () => {
  if (!window.location.hash) {
    window.location.hash = '#/'
  } else {
    render()
  }
})
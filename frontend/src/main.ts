import './index.css'
import { render } from './router'
import { socketService } from './socket.service'
import { setState } from './store'

// Initialize socket connection (this triggers the Render cold-start if needed)
socketService.connect()

// Record when the frontend first loaded so we can estimate server boot time
setState({ serverBootStartTime: Date.now() })

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
import { createFileRoute } from '@tanstack/react-router'

import WatermarkPage from '@/features/watermark/WatermarkPage'

export const Route = createFileRoute('/tools/watermark')({
  component: WatermarkPage,
})

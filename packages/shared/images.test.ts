import { describe, expect, it } from 'vitest'
import { fitImage, thumbnailSize } from './images'

describe('fitImage', () => {
  it('preserves the aspect ratio and never upscales', () => {
    expect(fitImage(2320, 1640)).toEqual({ width: 720, height: 509 })
    expect(fitImage(900, 2700)).toEqual({ width: 240, height: 720 })
    expect(fitImage(320, 180)).toEqual({ width: 320, height: 180 })
  })

  it('fits the card rectangle, including portrait and panoramic images', () => {
    expect(fitImage(1600, 900, 256, 156)).toEqual({ width: 256, height: 144 })
    expect(fitImage(900, 2700, 256, 156)).toEqual({ width: 52, height: 156 })
    expect(fitImage(832, 96, 256, 156)).toEqual({ width: 256, height: 30 })
    expect(fitImage(32, 18, 256, 156)).toEqual({ width: 32, height: 18 })
    expect(fitImage(100, 100, Number.NaN, 156)).toEqual({ width: 1, height: 1 })
  })

  it('keeps tiny and invalid dimensions usable', () => {
    expect(fitImage(1, 10000)).toEqual({ width: 1, height: 720 })
    expect(fitImage(0, 100)).toEqual({ width: 1, height: 1 })
    expect(fitImage(Number.NaN, 100)).toEqual({ width: 1, height: 1 })
  })
})

describe('thumbnailSize', () => {
  it('uses the frame dimensions and display density without a 720px floor', () => {
    expect(thumbnailSize(128, 78, 1)).toEqual({ width: 128, height: 78 })
    expect(thumbnailSize(128, 78, 2)).toEqual({ width: 256, height: 156 })
    expect(thumbnailSize(116, 70, 2)).toEqual({ width: 232, height: 140 })
    expect(thumbnailSize(128, 78, 1.25)).toEqual({ width: 160, height: 98 })
    expect(thumbnailSize(128, 78, 8)).toEqual({ width: 384, height: 234 })
  })

  it('bounds invalid sizes and densities', () => {
    expect(thumbnailSize(10000, 10000, 2)).toEqual({ width: 512, height: 512 })
    expect(thumbnailSize(0, Number.NaN, Infinity)).toEqual({ width: 128, height: 78 })
  })
})

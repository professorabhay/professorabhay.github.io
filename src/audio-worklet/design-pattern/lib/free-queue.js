/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */
// Byte per audio sample. (32 bit float)
const BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;

// Basic byte unit of WASM heap. (16 bit = 2 bytes)
const BYTES_PER_UNIT = Uint16Array.BYTES_PER_ELEMENT;

// The max audio channel on Chrome is 32.
const MAX_CHANNEL_COUNT = 32;

// WebAudio's render quantum size.
const RENDER_QUANTUM_FRAMES = 128;

/**
 * A WASM HEAP wrapper for AudioBuffer class. This breaks down the AudioBuffer
 * into an Array of Float32Array for the convinient WASM opearion.
 *
 * @class
 * @dependency Module A WASM module generated by the emscripten glue code.
 */
class FreeQueue {

    /**
   * Constructor
   * @param  {object|number} arg1 WASM module generated by Emscripten or size.
   * @param  {number} [arg2] Length Buffer frame length or channel count ring.
   * @param  {number} [arg3] Channel count.
   * @param  {number} [arg4] Maximum number of channels.
   */

    constructor(arg1, arg2, arg3, arg4) {
      if (typeof arg1 === 'number' && (typeof arg2 === 'number' || arg2 === undefined)) {
        // Handle the (size, channelCountRing) constructor
        this._initSharedRingBuffer(arg1, arg2 || 1);
      } else if (typeof arg1 === 'object' && typeof arg2 === 'number' && typeof arg3 === 'number') {
        // Handle the (wasmModule, length, channelCount, maxChannelCount) constructor
        this._initWasmHeap(arg1, arg2, arg3, arg4);
      } else {
        throw new Error("Invalid constructor arguments");
      }
    }

     /**
   * Initialize as a SharedRingBuffer
   * @param {number} size
   * @param {number} channelCountRing
   */
  _initSharedRingBuffer(size, channelCountRing=1) {
    this.states = new Uint32Array(new SharedArrayBuffer(
        Object.keys(this.States).length * Uint32Array.BYTES_PER_ELEMENT));
    /**
     * Use one extra bin to distinguish between the read and write indices 
     * when full. See Tim Blechmann's |boost::lockfree::spsc_queue|
     * implementation.
     */
    this.bufferLength = size + 1;
    this.channelCountRing = channelCountRing;
    this.channelDataRing = [];
    for (let i = 0; i < channelCountRing; i++) {
      this.channelDataRing.push(new Float32Array(new SharedArrayBuffer(
        this.bufferLength * Float32Array.BYTES_PER_ELEMENT)));
    }
  }

  /**
   * Initialize as a WASM HEAP wrapper
   * @param  {object} wasmModule WASM module generated by Emscripten.
   * @param  {number} length Buffer frame length.
   * @param  {number} channelCount Number of channels.
   * @param  {number=} maxChannelCount Maximum number of channels.
   */
  _initWasmHeap(wasmModule, length, channelCount, maxChannelCount) {
    this._isInitialized = false;
    this._module = wasmModule;
    this._length = length;
    this._maxChannelCount = maxChannelCount ?
      Math.min(maxChannelCount, MAX_CHANNEL_COUNT) : channelCount;
    this._channelCount = channelCount;
    this._allocateHeap();
    this._isInitialized = true;

    this._readIndex = 0;
    this._writeIndex = 0;
    this._framesAvailable = 0;
  }

  /**
   * Allocates memory in the WASM heap and set up Float32Array views for the
   * channel data.
   *
   * @private
   */
  _allocateHeap() {
    const channelByteSize = this._length * BYTES_PER_SAMPLE;
    const dataByteSize = this._channelCount * channelByteSize;
    this._dataPtr = this._module._malloc(dataByteSize);
    this._channelData = [];
    for (let i = 0; i < this._channelCount; ++i) {
      const startByteOffset = this._dataPtr + i * channelByteSize;
      const endByteOffset = startByteOffset + channelByteSize;
      // Get the actual array index by dividing the byte offset by 2 bytes.
      this._channelData[i] =
          this._module.HEAPF32.subarray(
              startByteOffset >> BYTES_PER_UNIT,
              endByteOffset >> BYTES_PER_UNIT);
    }
  }

  /**
   * Adapt the current channel count to the new input buffer.
   *
   * @param  {number} newChannelCount The new channel count.
   */
  adaptChannel(newChannelCount) {
    if (newChannelCount < this._maxChannelCount) {
      this._channelCount = newChannelCount;
    }
  }

  /**
   * Getter for the buffer length in frames.
   *
   * @return {?number} Buffer length in frames.
   */
  get length() {
    return this._isInitialized ? this._length : null;
  }

  /**
   * Getter for the number of channels.
   *
   * @return {?number} Buffer length in frames.
   */
  get numberOfChannels() {
    return this._isInitialized ? this._channelCount : null;
  }

  /**
   * Getter for the maxixmum number of channels allowed for the instance.
   *
   * @return {?number} Buffer length in frames.
   */
  get maxChannelCount() {
    return this._isInitialized ? this._maxChannelCount : null;
  }

  /**
   * Returns a Float32Array object for a given channel index. If the channel
   * index is undefined, it returns the reference to the entire array of channel
   * data.
   *
   * @param  {number|undefined} channelIndex Channel index.
   * @return {?Array} a channel data array or an
   * array of channel data.
   */
  getChannelData(channelIndex) {
    if (channelIndex >= this._channelCount) {
      return null;
    }

    return typeof channelIndex === 'undefined' ?
        this._channelData : this._channelData[channelIndex];
  }

  /**
   * Returns the base address of the allocated memory space in the WASM heap.
   *
   * @return {number} WASM Heap address.
   */
  getHeapAddress() {
    return this._dataPtr;
  }

  /**
   * Returns the base address of the allocated memory space in the WASM heap.
   *
   * @return {number} WASM Heap address.
   */
  getPointer() {
    return this._dataPtr;
  }

  /**
   * Frees the allocated memory space in the WASM heap.
   */
  free() {
    this._isInitialized = false;
    this._module._free(this._dataPtr);
    this._module._free(this._pointerArrayPtr);
    this._channelData = null;
  }

/**
 * A JS FIFO implementation for the AudioWorklet. 3 assumptions for the
 * simpler operation:
 *  1. the push and the pull operation are done by 128 frames. (Web Audio
 *    API's render quantum size in the speficiation)
 *  2. the channel count of input/output cannot be changed dynamically.
 *    The AudioWorkletNode should be configured with the `.channelCount = k`
 *    (where k is the channel count you want) and
 *    `.channelCountMode = explicit`.
 *  3. This is for the single-thread operation. (obviously)
 *
 *
 */

  /**
   * Getter for Available frames in buffer.
   *
   * @return {number} Available frames in buffer.
   */
  get framesAvailable() {
    return this._framesAvailable;
  }

  /**
   * Push a sequence of Float32Arrays to buffer.
   *
   * @param  {array} arraySequence A sequence of Float32Arrays.
   */
  pushRing(arraySequence) {
    // The channel count of arraySequence and the length of each channel must
    // match with this buffer obejct.

    // Transfer data from the |arraySequence| storage to the internal buffer.
    const sourceLength = arraySequence[0].length;
    for (let i = 0; i < sourceLength; ++i) {
      for (let channel = 0; channel < this._channelCount; ++channel) {
        this._channelData[channel][this._writeIndex] = arraySequence[channel][i];
      }
      this._writeIndex = (this._writeIndex + 1) % this._length;
    }

    // For excessive frames, the buffer will be overwritten.
    this._framesAvailable += sourceLength;
    if (this._framesAvailable > this._length) {
      this._framesAvailable = this._length;
    }
  }

  /**
   * Pull data out of buffer and fill a given sequence of Float32Arrays.
   *
   * @param  {array} arraySequence An array of Float32Arrays.
   */
  pullRing(arraySequence) {
    // The channel count of arraySequence and the length of each channel must
    // match with this buffer obejct.

    // If the FIFO is completely empty, do nothing.
    if (this._framesAvailable === 0) {
      return;
    }

    const destinationLength = arraySequence[0].length;

    // Transfer data from the internal buffer to the |arraySequence| storage.
    for (let i = 0; i < destinationLength; ++i) {
      for (let channel = 0; channel < this._channelCount; ++channel) {
        arraySequence[channel][i] = this._channelData[channel][this._readIndex];
      }
      this._readIndex = (this._readIndex + 1) % this._length;
    }

    this._framesAvailable -= destinationLength;
    if (this._framesAvailable < 0) {
      this._framesAvailable = 0;
    }
  }

  /**
 * A shared storage for FreeQueue operation backed by SharedArrayBuffer.
 *
 * @typedef SharedRingBuffer
 * @property {Uint32Array} states Backed by SharedArrayBuffer.
 * @property {number} bufferLength The frame buffer length. Should be identical
 * throughout channels.
 * @property {Array<Float32Array>} channelDataRing The length must be > 0.
 * @property {number} channelCountRing same with channelData.length
 */

  /**
 * A single-producer/single-consumer lock-free FIFO backed by SharedArrayBuffer.
 * In a typical pattern is that a worklet pulls the data from the queue and a
 * worker renders audio data to fill in the queue.
 */

   /**
   * An index set for shared state fields. Requires atomic access.
   * @enum {number}
   */
   States = {
    /** @type {number} A shared index for reading from the queue. (consumer) */
    READ: 0,
    /** @type {number} A shared index for writing into the queue. (producer) */
    WRITE: 1,  
  }

  /**
   * Helper function for creating FreeQueue from pointers.
   * @param {RingBufferSharedArrayBufferPointers} queuePointers 
   * An object containing various pointers required to create FreeQueue
   *
   * interface FreeQueuePointers {
   *   memory: WebAssembly.Memory;   // Reference to WebAssembly Memory
   *   bufferLengthPointer: number;
   *   channelCountPointer: number;
   *   statePointer: number;
   *   channelDataPointer: number;
   * }
   * @returns FreeQueue
   */
  static fromPointers(queuePointers) {
    const queue = new RingBufferSharedArrayBuffer(0, 0);
    const HEAPU32 = new Uint32Array(queuePointers.memory.buffer);
    const HEAPF32 = new Float32Array(queuePointers.memory.buffer);
    const bufferLength = HEAPU32[queuePointers.bufferLengthPointer / 4];
    const channelCountRing = HEAPU32[queuePointers.channelCountPointer / 4];
    const states = HEAPU32.subarray(
        HEAPU32[queuePointers.statePointer / 4] / 4,
        HEAPU32[queuePointers.statePointer / 4] / 4 + 2
    );
    const channelDataRing = [];
    for (let i = 0; i < channelCountRing; i++) {
      channelDataRing.push(
          HEAPF32.subarray(
              HEAPU32[HEAPU32[queuePointers.channelDataPointer / 4] / 4 + i] / 4,
              HEAPU32[HEAPU32[queuePointers.channelDataPointer / 4] / 4 + i] / 4 +
                  bufferLength
        )
      );
    }
    queue.bufferLength = bufferLength;
    queue.channelCountRing = channelCountRing;
    queue.states = states;
    queue.channelDataRing = channelDataRing;
    return queue;
  }

  /**
   * Pushes the data into queue. Used by producer.
   *
   * @param {Float32Array[]} input Its length must match with the channel
   *   count of this queue.
   * @param {number} blockLength Input block frame length. It must be identical
   *   throughout channels.
   * @return {boolean} False if the operation fails.
   */
  push(input, blockLength) {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    if (this._getAvailableWrite(currentRead, currentWrite) < blockLength) {
      return false;
    }
    let nextWrite = currentWrite + blockLength;
    if (this.bufferLength < nextWrite) {
      nextWrite -= this.bufferLength;
      for (let channel = 0; channel < this.channelCountRing; channel++) {
        const blockA = this.channelDataRing[channel].subarray(currentWrite);
        const blockB = this.channelDataRing[channel].subarray(0, nextWrite);
        blockA.set(input[channel].subarray(0, blockA.length));
        blockB.set(input[channel].subarray(blockA.length));
      }
    } else {
      for (let channel = 0; channel < this.channelCountRing; channel++) {
        this.channelDataRing[channel]
            .subarray(currentWrite, nextWrite)
            .set(input[channel].subarray(0, blockLength));
      }
      if (nextWrite === this.bufferLength) nextWrite = 0;
    }
    Atomics.store(this.states, this.States.WRITE, nextWrite);
    return true;
  }

  /**
   * Pulls data out of the queue. Used by consumer.
   *
   * @param {Float32Array[]} output Its length must match with the channel
   *   count of this queue.
   * @param {number} blockLength output block length. It must be identical
   *   throughout channels.
   * @return {boolean} False if the operation fails.
   */
  pull(output, blockLength) {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    if (this._getAvailableRead(currentRead, currentWrite) < blockLength) {
      return false;
    }
    let nextRead = currentRead + blockLength;
    if (this.bufferLength < nextRead) {
      nextRead -= this.bufferLength;
      for (let channel = 0; channel < this.channelCountRing; channel++) {
        const blockA = this.channelDataRing[channel].subarray(currentRead);
        const blockB = this.channelDataRing[channel].subarray(0, nextRead);
        output[channel].set(blockA);
        output[channel].set(blockB, blockA.length);
      }
    } else {
      for (let channel = 0; channel < this.channelCountRing; ++channel) {
        output[channel].set(
            this.channelDataRing[channel].subarray(currentRead, nextRead)
        );
      }
      if (nextRead === this.bufferLength) {
        nextRead = 0;
      }
    }
    Atomics.store(this.states, this.States.READ, nextRead);
    return true;
  }
  /**
   * Helper function for debugging.
   * Prints currently available read and write.
   */
  printAvailableReadAndWrite() {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    console.log(this, {
        availableRead: this._getAvailableRead(currentRead, currentWrite),
        availableWrite: this._getAvailableWrite(currentRead, currentWrite),
    });
  }
  /**
   * 
   * @returns {number} number of samples available for read
   */
  getAvailableSamples() {
    const currentRead = Atomics.load(this.states, this.States.READ);
    const currentWrite = Atomics.load(this.states, this.States.WRITE);
    return this._getAvailableRead(currentRead, currentWrite);
  }
  /**
   * 
   * @param {number} size 
   * @returns boolean. if frame of given size is available or not.
   */
  isFrameAvailable(size) {
    return this.getAvailableSamples() >= size;
  }

  /**
   * @return {number}
   */
  getBufferLength() {
    return this.bufferLength - 1;
  }

  _getAvailableWrite(readIndex, writeIndex) {
    if (writeIndex >= readIndex)
        return this.bufferLength - writeIndex + readIndex - 1;
    return readIndex - writeIndex - 1;
  }

  _getAvailableRead(readIndex, writeIndex) {
    if (writeIndex >= readIndex) return writeIndex - readIndex;
    return writeIndex + this.bufferLength - readIndex;
  }

  _reset() {
    for (let channel = 0; channel < this.channelCountRing; channel++) {
      this.channelDataRing[channel].fill(0);
    }
    Atomics.store(this.states, this.States.READ, 0);
    Atomics.store(this.states, this.States.WRITE, 0);
  }
}

export {
  MAX_CHANNEL_COUNT,
  RENDER_QUANTUM_FRAMES,
  FreeQueue,
};
// 发送窗口（流控）：未确认字节不超过 limit，避免打爆接收端与自己的内存。

export class SendWindow {
  #limit;
  #sent = 0;
  #acked = 0;
  #waiters = [];
  #failure = null;

  constructor(limitBytes) {
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      throw new RangeError(`窗口上限必须是正数，实际 ${limitBytes}`);
    }
    this.#limit = limitBytes;
  }

  get limit() {
    return this.#limit;
  }

  /** 已发出但未被确认的字节数。 */
  get inflight() {
    return this.#sent - this.#acked;
  }

  get available() {
    return Math.max(0, this.#limit - this.inflight);
  }

  /**
   * 断点续传基值：窗口从"已经有这么多字节在途/已确认"开始计数，
   * 这样接收端的绝对进度 ack 依然能正确约束窗口。
   */
  prime(bytes) {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError(`prime 需要非负整数，实际 ${bytes}`);
    }
    this.#sent = Math.max(this.#sent, bytes);
    this.#acked = Math.max(this.#acked, bytes);
  }

  /** 记下"已经交给数据通道"的字节。 */
  add(bytes) {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new RangeError(`add 需要非负整数，实际 ${bytes}`);
    }
    this.#sent += bytes;
  }

  /** 接收端的绝对进度（同一文件的累计已收字节数）。 */
  ack(receivedBytes) {
    if (this.#failure) {
      return;
    }
    if (!Number.isInteger(receivedBytes) || receivedBytes < 0) {
      throw new RangeError(`ack 需要非负整数，实际 ${receivedBytes}`);
    }
    // 忽略回退的 ack（乱序/重复确认都不会让窗口虚增）
    this.#acked = Math.max(this.#acked, Math.min(receivedBytes, this.#sent));
    this.#flush();
  }

  canSend(bytes = 0) {
    if (this.#failure) {
      return false;
    }
    return this.inflight + bytes <= this.#limit;
  }

  /**
   * 等到窗口里"当前"放得下这么多字节为止。
   *
   * 语义是软闸门（soft gate）：只依据 inflight 判断，不预留字节。
   * 调用方拿到放行后立刻 add(bytes) 并发送即可；极限情况下最多超出一块，
   * 这是流控常见的取舍（换取简单、无死锁）。
   */
  waitForRoom(bytes = 0) {
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }
    if (this.canSend(bytes)) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ bytes, resolve, reject });
    });
  }

  /** 传输失败/取消：唤醒所有等待者并让后续调用直接失败。 */
  fail(error) {
    this.#failure = error ?? new Error('传输已中止');
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      waiter.reject(this.#failure);
    }
  }

  get failing() {
    return this.#failure;
  }

  #flush() {
    const pending = [];
    for (const waiter of this.#waiters) {
      if (this.canSend(waiter.bytes)) {
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.#waiters = pending;
  }
}

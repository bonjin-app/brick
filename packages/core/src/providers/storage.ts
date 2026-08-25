/**
 * StorageProvider 추상화.
 * 기본: LocalStorage(uploads/ 디렉터리). 설정 시 S3/R2/MinIO.
 * → MinIO조차 docker-compose 필수 구성이 아니다.
 */
export interface StoredFile {
  key: string;
  size: number;
  contentType: string;
  url: string;
}

export interface StorageProvider {
  put(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<StoredFile>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

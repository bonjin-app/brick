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
  /**
   * `publicUrl` 의 역함수 — 이 주소가 우리가 저장한 파일이면 그 키를, 아니면 null.
   *
   * 주소에서 키를 되찾아야 하는 곳이 있다(운영자가 고른 사진의 썸네일 찾기 등). 규칙을
   * 아는 쪽은 주소를 만든 제공자뿐이므로, 부르는 쪽이 "/uploads/ 를 떼면 된다"고 짐작하지
   * 않게 여기서 뒤집는다 — 짐작을 퍼뜨리면 S3 로 바꿀 때 그 짐작을 전부 찾아다녀야 한다.
   */
  keyFromUrl(url: string): string | null;
}

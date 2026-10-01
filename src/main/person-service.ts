import type {
  AnalysisQueueStats,
  ConfirmPersonResult,
  FaceEmbeddingSet,
  MergePersonsResult,
  PersonCorrectionResult,
  PersonCandidate,
  PersonClusterInput,
  PersonOverview,
  PersonRecord
} from "../shared/protocol";
import { AnalysisService } from "./analysis-service";
import { CatalogService } from "./catalog-service";

const ALGORITHM_VERSION = "person-centroid-v1";

type ClusterWorkerResult = {
  algorithm: string;
  clusterThreshold: number;
  verificationThreshold: number;
  clusterCount: number;
  clusters: PersonClusterInput[];
};

export class PersonService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly analysis: AnalysisService
  ) {}

  async getOverview(
    sourceId: number,
    forceRefresh = false
  ): Promise<PersonOverview> {
    const queue = await this.catalog.request<AnalysisQueueStats>(
      "getAnalysisQueueStats",
      {
        sourceId,
        module: "face-embed-sface-v1"
      }
    );

    const clusteringPending = queue.pending > 0 || queue.running > 0;

    if (!clusteringPending && this.analysis.getStatus().state === "READY") {
      const set = await this.catalog.request<FaceEmbeddingSet>(
        "getFaceEmbeddingsForClustering",
        {
          sourceId,
          algorithmVersion: ALGORITHM_VERSION
        }
      );

      if (forceRefresh || set.needsRebuild) {
        const clustered = await this.analysis.request<ClusterWorkerResult>(
          "cluster_face_embeddings",
          {
            faces: set.faces,
            cannotLinks: set.cannotLinks,
            clusterThreshold: 0.50,
            verificationThreshold: 0.363
          },
          120000
        );

        await this.catalog.request("replacePersonCandidates", {
          sourceId,
          revision: set.revision,
          algorithmVersion: ALGORITHM_VERSION,
          clusters: clustered.clusters
        });
      }
    }

    const [candidates, persons] = await Promise.all([
      this.catalog.request<PersonCandidate[]>("listPersonCandidates", {
        sourceId,
        limit: 100
      }),
      this.catalog.request<PersonRecord[]>("listPersons", { sourceId })
    ]);

    return {
      candidates,
      persons,
      clusteringPending
    };
  }

  async refreshAllSources(): Promise<void> {
    const sources = await this.catalog.request<Array<{
      id: number;
      path: string;
      enabled: boolean;
    }>>("listSources");

    for (const source of sources) {
      if (!source.enabled) continue;
      await this.getOverview(source.id);
    }
  }

  async confirmCandidate(
    candidateId: number,
    name: string
  ): Promise<ConfirmPersonResult> {
    return this.catalog.request<ConfirmPersonResult>(
      "confirmPersonCandidate",
      { candidateId, name }
    );
  }

  async removeCandidateFace(
    candidateId: number,
    faceDetectionId: number
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "removeFaceFromPersonCandidate",
      { candidateId, faceDetectionId }
    );
  }

  async removePersonFace(
    personId: number,
    faceDetectionId: number
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "removeFaceFromPerson",
      { personId, faceDetectionId }
    );
  }

  async mergePersons(
    targetPersonId: number,
    sourcePersonId: number
  ): Promise<MergePersonsResult> {
    return this.catalog.request<MergePersonsResult>(
      "mergePersons",
      { targetPersonId, sourcePersonId }
    );
  }

  async renamePerson(
    personId: number,
    name: string
  ): Promise<PersonCorrectionResult> {
    return this.catalog.request<PersonCorrectionResult>(
      "renamePerson",
      { personId, name }
    );
  }
}

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import (
    auth,
    admin,
    audit,
    faculty,
    subjects,
    class_schedules,
    sections,
    student_enrollment,
    enrollment_config,
)

app = FastAPI(
    title="EVSU-OC Student Enrollment System API",
    description="Backend API for the EVSU-OC Student Enrollment System",
    version="1.0.0",
)

# ---------------------------------------------------------------------------
# CORS — adjust origins for your frontend
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restrict to your frontend URL in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(auth.router, prefix="/api/v1")
app.include_router(admin.router, prefix="/api/v1")
app.include_router(audit.router, prefix="/api/v1")
app.include_router(faculty.router, prefix="/api/v1")
app.include_router(subjects.router, prefix="/api/v1")
app.include_router(class_schedules.router, prefix="/api/v1")
app.include_router(sections.router, prefix="/api/v1")
app.include_router(student_enrollment.router, prefix="/api/v1")
app.include_router(enrollment_config.router, prefix="/api/v1")


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.get("/", tags=["Health"])
def health_check():
    """Simple health check endpoint."""
    return {"status": "ok", "message": "EVSU-OC Enrollment API is running"}

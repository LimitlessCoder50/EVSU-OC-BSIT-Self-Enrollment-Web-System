from datetime import datetime, time
from typing import Annotated, Literal, Optional
from pydantic import BaseModel, EmailStr, Field, StringConstraints, field_validator, model_validator
from uuid import UUID


IDNumber = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
FacultyRole = Literal["department_head", "instructor"]


# ---------------------------------------------------------------------------
# Admin schemas
# ---------------------------------------------------------------------------

class AdminCreate(BaseModel):
    """Schema for creating a new admin."""
    fname: str
    mname: Optional[str] = None
    lname: str
    id_number: IDNumber
    email: EmailStr
    password: str


class AdminUpdate(BaseModel):
    """Schema for updating an existing admin."""
    fname: Optional[str] = None
    mname: Optional[str] = None
    lname: Optional[str] = None
    id_number: Optional[IDNumber] = None
    email: Optional[EmailStr] = None
    is_active: Optional[bool] = None


class AdminResponse(BaseModel):
    """Schema for admin data returned to the client (no password)."""
    id: int
    public_id: str
    fname: str
    mname: Optional[str] = None
    lname: str
    id_number: str
    email: str
    is_active: bool
    role: str
    created_at: datetime


# ---------------------------------------------------------------------------
# Faculty schemas
# ---------------------------------------------------------------------------

class FacultyCreate(BaseModel):
    """Schema for creating a department head or instructor account."""
    fname: str
    mname: Optional[str] = None
    lname: str
    id_number: IDNumber
    email: EmailStr
    password: str
    role: FacultyRole


class FacultyUpdate(BaseModel):
    """Schema for updating faculty account details."""
    fname: Optional[str] = None
    mname: Optional[str] = None
    lname: Optional[str] = None
    id_number: Optional[IDNumber] = None
    email: Optional[EmailStr] = None
    role: Optional[FacultyRole] = None
    is_active: Optional[bool] = None


class FacultyResponse(BaseModel):
    """Schema for faculty account data returned to the client."""
    id: int
    public_id: str
    fname: str
    mname: Optional[str] = None
    lname: str
    id_number: str
    email: str
    is_active: bool
    role: FacultyRole
    created_at: datetime


# ---------------------------------------------------------------------------
# Student schemas
# ---------------------------------------------------------------------------

class StudentCreate(BaseModel):
    """Schema for a student self-registration."""
    id_number: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            pattern=r"^[0-9]{4}-[0-9]{5}$",
            min_length=10,
            max_length=10,
        ),
    ]
    fname: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    mname: Optional[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]] = None
    lname: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    email: EmailStr
    password: Annotated[str, Field(min_length=8, max_length=72)]
    year_level: int = Field(default=1, ge=1, le=4)
    semester: int = Field(default=1, ge=1, le=3)

    @field_validator("password")
    @classmethod
    def validate_password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be no more than 72 UTF-8 bytes")
        return value


class StudentResponse(BaseModel):
    """Schema for student profile data returned to the client."""
    id: int
    public_id: str
    id_number: str
    fname: str
    mname: Optional[str] = None
    lname: str
    email: str
    year_level: int
    semester: int
    is_active: bool
    created_at: datetime


class EnrollmentSessionResponse(BaseModel):
    """Current student's enrollment session and a temporary private file link."""
    id: int
    public_id: str
    year_level: int
    semester: int
    fhe_form_url: str
    fhe_status: str
    created_at: datetime


class AvailableScheduleResponse(BaseModel):
    """Class schedule offered for a student's current year and semester."""
    public_id: str
    section_name: str
    course_no: str
    subject_title: str
    instructor_name: str
    days: str
    start_time: time
    end_time: time
    room: str
    lec_units: int
    lab_units: int
    total_units: int


class StudentEnrollmentWindowResponse(BaseModel):
    """Current academic term and whether students may submit FHE forms."""
    active_school_year: str
    active_semester: int
    enrollment_start: datetime
    enrollment_end: datetime
    fhe_upload_open: bool
    fhe_upload_state: Literal["not_started", "open", "closed"]


class StudentDashboardResponse(BaseModel):
    """Student profile, current-term enrollment window, and matching schedules."""
    student: StudentResponse
    enrollment_session: Optional[EnrollmentSessionResponse] = None
    available_schedules: list[AvailableScheduleResponse] = Field(default_factory=list)
    enrollment_window: StudentEnrollmentWindowResponse


# ---------------------------------------------------------------------------
# Enrollment configuration schemas
# ---------------------------------------------------------------------------

class EnrollmentConfigurationUpdate(BaseModel):
    """Department-head-managed academic term and enrollment window."""
    active_school_year: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            pattern=r"^[0-9]{4}-[0-9]{4}$",
            min_length=9,
            max_length=9,
        ),
    ]
    active_semester: int = Field(ge=1, le=3)
    enrollment_start: datetime
    enrollment_end: datetime

    @field_validator("enrollment_start", "enrollment_end")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Enrollment dates must include a time zone")
        return value

    @model_validator(mode="after")
    def validate_enrollment_window(self):
        if self.enrollment_start >= self.enrollment_end:
            raise ValueError("Enrollment end must be later than enrollment start")
        return self


class EnrollmentConfigurationResponse(EnrollmentConfigurationUpdate):
    """Active system enrollment settings returned to authorized staff."""
    id: int
    updated_at: datetime


# ---------------------------------------------------------------------------
# Subject schemas
# ---------------------------------------------------------------------------

class SubjectCreate(BaseModel):
    """Schema for creating a curriculum subject."""
    course_no: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    lec_units: int = Field(default=0, ge=0)
    lab_units: int = Field(default=0, ge=0)
    total_units: int = Field(ge=0)
    pre_requisite: str = "None"
    year_level: int = Field(ge=1, le=4)
    semester: int = Field(ge=1, le=3)


class SubjectUpdate(BaseModel):
    """Schema for updating a curriculum subject."""
    course_no: Optional[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]] = None
    title: Optional[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]] = None
    lec_units: Optional[int] = Field(default=None, ge=0)
    lab_units: Optional[int] = Field(default=None, ge=0)
    total_units: Optional[int] = Field(default=None, ge=0)
    pre_requisite: Optional[str] = None
    year_level: Optional[int] = Field(default=None, ge=1, le=4)
    semester: Optional[int] = Field(default=None, ge=1, le=3)


class SubjectResponse(BaseModel):
    """Schema for curriculum subject data."""
    id: int
    public_id: UUID
    course_no: str
    title: str
    lec_units: int
    lab_units: int
    total_units: int
    pre_requisite: str
    year_level: int
    semester: int
    created_at: datetime


# ---------------------------------------------------------------------------
# Class schedule schemas
# ---------------------------------------------------------------------------

class ClassScheduleCreate(BaseModel):
    """Schema for scheduling a section, subject, and instructor."""
    section_id: int = Field(gt=0)
    subject_id: int = Field(gt=0)
    instructor_id: int = Field(gt=0)
    room: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] = "TBA"
    days: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)]
    start_time: time
    end_time: time

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_local_time(cls, value: time) -> time:
        if value.tzinfo is not None and value.utcoffset() is not None:
            raise ValueError("Times must not include a time zone")
        return value

    @model_validator(mode="after")
    def validate_time_range(self):
        if self.start_time >= self.end_time:
            raise ValueError("End time must be later than start time")
        return self


class ClassScheduleUpdate(BaseModel):
    """Schema for updating a class schedule."""
    section_id: int | None = Field(default=None, gt=0)
    subject_id: int | None = Field(default=None, gt=0)
    instructor_id: int | None = Field(default=None, gt=0)
    room: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    days: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)] | None = None
    start_time: time | None = None
    end_time: time | None = None

    @field_validator("section_id", "subject_id", "instructor_id", "room", "days", mode="before")
    @classmethod
    def reject_null_schedule_values(cls, value):
        if value is None:
            raise ValueError("This field cannot be null")
        return value

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_local_time(cls, value: time | None) -> time | None:
        if value is None:
            raise ValueError("This field cannot be null")
        if value.tzinfo is not None and value.utcoffset() is not None:
            raise ValueError("Times must not include a time zone")
        return value


class ClassScheduleResponse(BaseModel):
    """Schema for a class schedule record."""
    id: int
    public_id: str
    section_id: int
    subject_id: int
    instructor_id: int
    room: str
    days: str
    start_time: time
    end_time: time
    created_at: datetime


class ScheduleEnrolledStudentResponse(BaseModel):
    """Student enrolled in an instructor's scheduled class."""
    id_number: str
    fname: str
    mname: Optional[str] = None
    lname: str
    year_level: int
    semester: int
    enrollment_status: Literal["PENDING", "APPROVED"]
    enrolled_at: datetime


# ---------------------------------------------------------------------------
# Student section schemas
# ---------------------------------------------------------------------------

class SectionCreate(BaseModel):
    """Schema for creating a student section."""
    section_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    year_level: int = Field(ge=1, le=4)
    capacity: int = Field(default=40, ge=1, le=2_147_483_647)
    semester: int = Field(ge=1, le=3)


class SectionUpdate(BaseModel):
    """Schema for updating a student section."""
    section_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)] | None = None
    year_level: int | None = Field(default=None, ge=1, le=4)
    capacity: int | None = Field(default=None, ge=1, le=2_147_483_647)
    semester: int | None = Field(default=None, ge=1, le=3)

    @field_validator("section_name", "year_level", "capacity", "semester", mode="before")
    @classmethod
    def reject_null_section_values(cls, value):
        if value is None:
            raise ValueError("This field cannot be null")
        return value


class SectionResponse(BaseModel):
    """Schema for a student section record."""
    id: int
    public_id: str
    section_name: str
    year_level: int
    capacity: int
    semester: int
    created_at: datetime


class ClassScheduleOptionsResponse(BaseModel):
    """Section, subject, and instructor choices for scheduling."""
    sections: list[SectionResponse]
    subjects: list[SubjectResponse]
    instructors: list[FacultyResponse]


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    """Schema for login credentials."""
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    """Schema for JWT token response."""
    access_token: str
    token_type: str = "bearer"
    admin: AdminResponse


class FacultyTokenResponse(BaseModel):
    """Schema for faculty login response."""
    access_token: str
    token_type: str = "bearer"
    faculty: FacultyResponse


class StudentTokenResponse(BaseModel):
    """Schema for student authentication responses."""
    access_token: str
    token_type: str = "bearer"
    student: StudentResponse


class ChangePasswordRequest(BaseModel):
    """Schema for changing password."""
    current_password: str
    new_password: str


# ---------------------------------------------------------------------------
# Audit log schemas
# ---------------------------------------------------------------------------

class AuditLogCreate(BaseModel):
    """Schema for creating an audit log entry."""
    admin_id: Optional[int] = None
    faculty_id: Optional[int] = None
    action: str
    ip_address: Optional[str] = None


class AuditLogResponse(BaseModel):
    """Schema for audit log data returned to the client."""
    id: int
    admin_id: Optional[int] = None
    faculty_id: Optional[int] = None
    actor_name: Optional[str] = None
    action: str
    ip_address: Optional[str] = None
    created_at: datetime


# ---------------------------------------------------------------------------
# Generic response
# ---------------------------------------------------------------------------

class MessageResponse(BaseModel):
    """Generic message response."""
    message: str
